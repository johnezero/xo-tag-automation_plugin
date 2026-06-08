# xo-tag-automation

**Tag-Based VM Performance & Permission Management via assigned tag(s) for Xen Orchestra**

Automate VM performance tiers, group permissions, and metadata management across XCP-ng pools — driven by VM tags and NFS-hosted CSV files, all from the native XO plugin UI.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Upgrading from the Standalone Script](#upgrading-from-the-standalone-script)
- [Configuration](#configuration)
- [CSV Workflow](#csv-workflow)
- [Performance Tiers](#performance-tiers)
- [Permission Sync and Autopilot](#permission-sync-and-autopilot)
- [Security](#security)
- [xo-cli API Methods](#xo-cli-api-methods)
- [Logging](#logging)
- [Changelog](#changelog)
- [Credits](#credits)
- [License](#license)

---

## Overview

`xo-tag-automation` is a native `xo-server` plugin that enforces VM performance tiers, manages XO group permissions, and synchronizes VM metadata -- all driven by VM tags and NFS-hosted CSV files. It replaces manual scripting and cron jobs with a modular, scheduled, UI-configurable automation framework built directly into Xen Orchestra.

---

## Features

### Performance Sync

Applies CPU weights and IO priorities (`sched-pri`) based on VM performance tier tags. All tier values are fully configurable in the plugin UI.

| Tag | CPU Weight | IO Priority |
|---|---|---|
| `0-core` | 2048 | 7 |
| `1-high` | 1024 | 7 |
| `2-normal` | 512 | 5 |
| `3-low` | 256 | 2 |

A configurable **tag suffix** (e.g. `-v`, `-1`) allows multi-pool management from a single XO instance without tag collisions.

### Permission Sync

VM tags ending in `-Admin`, `-Operator`, or `-Viewer` automatically trigger XO Group creation and ACL assignments. No manual group management required.

### CSV PERMISSION MANAGEMENT FILES

Two CSV files on your NFS share drive the workflow:

**`current-vms.csv`**
A live export of your entire VM inventory. Columns: `UUID`, `Name`, `CurrentTags`, `NewTags`, `CurrentNotes`, `NewNotes`. Edit the `NewTags` and `NewNotes` columns and run the plugin to apply changes in bulk. The CSV auto-refreshes after each run. A configurable staleness warning fires if the CSV has not been updated within a set number of days.

**`preload-vms.csv`**
Pre-stage tag and notes configurations for VMs that do not exist yet -- before they are migrated or created. The moment a matching VM appears in XO, the plugin applies (on next scheduled interval) its tags and notes automatically and removes the entry from the preload file.

### Permission Autopilot

Designed for active migration and onboarding projects. Automatically applies permission settings on scheduled interval, based on preload-vms.csv contents. Note: Should be disabled when not actively involved in migration projects.

### Dry-Run / Export-CSV Mode

When **Dry-Run** is ON (the default), the plugin previews all changes in the XO logs without applying anything, and simultaneously exports a fresh copy of all VM metadata to `current-vms.csv` with blank `NewTags` and `NewNotes` columns ready to fill in. Turn Dry-Run OFF to apply changes for real.

### Run Now (e.g. The [Test plugin] button)

Trigger a full enforcement cycle instantly from the XO plugin UI without waiting for the next scheduled run.

### NFS Logging

All activity is written to structured log files on your NFS share:

| File | Description |
|---|---|
| `xo-tag-automation.log` | Full run log (auto-rotates at 2MB, one backup kept) |
| `xo-tag-automation.log.1` | Previous log backup |
| `xo-tag-automation-summary.log` | Run summary entries only |
| `daily-summary.log` | Nightly VM count and new VM report (written at midnight) |

### Legacy Migration

If you have an existing `vm_metadata.csv` from an older standalone version, the plugin automatically renames it to `current-vms.csv` on first run. No manual migration needed.

---

## Requirements

- Xen Orchestra (`xo-server`) with plugin support
- Node.js >= 20
- An NFS share accessible from the XOA (see [Security](#security))
- XCP-ng / XenServer pool(s)

---

## Security

> **This plugin automates infrastructure changes. Security is not optional.**

### REST API Service Account

The plugin uses the XO JSON-RPC API internally. Use a dedicated service account -- never your personal admin credentials.

Recommended setup (generic -- adapt to your environment):

1. Create a dedicated XO user account for the service
   (e.g. a non-admin account with only minimal access required)

2. Generate a scoped API token via xo-cli:
     xo-cli --register
     xo-cli token.create

3. Store the token securely -- treat it like a password!

4. Refer to the [official Vates REST API documentation](https://xen-orchestra.com/docs/restapi.html) for full token management guidance.

---

### NFS Share Security

The NFS share hosts your CSV files and logs. Anyone with write access to the share can modify VM tags and permissions.

**STRONGLY RECOMMENDED**

  * Run the NFS share from a dedicated VM -- not a general-purpose NFS server.

  * Restrict NFS exports to the XOA IP address only:
      /srv/nfs/share  <XOA-IP>/32(rw,sync,no_subtree_check,no_root_squash)

  * Do NOT expose the NFS share to the general network or to end-user access.

  * Admins who need to edit CSV files can SCP them to/from the XOA:

      EXAMPLE:
      Download CSV from XOA to your workstation
      scp <xoa-user>@<xoa-ip>:/path/to/current-vms.csv ./

      Upload edited CSV back to XOA
      scp ./current-vms.csv <xoa-user>@<xoa-ip>:/path/to/current-vms.csv

  * Use firewall rules to enforce NFS access at the network level in addition to the exports configuration

  Failure to secure the NFS share is a serious security risk.

---

### UPGRADING FROM THE STANDALONE SCRIPT

If you installed the old standalone set-performance.sh script, you can 
remove it before enabling the plugin as follows:

1. Remove the script:
   ```bash
   sudo rm /usr/local/bin/set-performance.sh
   ```

2. Remove the crontab entry:
     crontab -e
     (delete the line referencing set-performance.sh)

3. The plugin handles its own scheduling via the XO UI.
   No manual cron configuration is required.

---

## Installation

1. Download the latest airgap release tarball from GitHub:
   https://github.com/johnezero/xo-tag-automation_plugin/releases

2. SCP the tarball to your XOA:
   ```bash
   scp xo-tag-automation-airgap-vX.X.X.tar.gz <xoa-user>@<xoa-ip>:/tmp/
   ```

3. Create the plugin folder:
   ```bash
   sudo mkdir -p /usr/local/lib/node_modules/xo-server-tag-automation
   ```

4. Extract directly into the plugin directory:
   ```bash
   sudo tar -xzvf /tmp/xo-tag-automation-airgap-vX.X.X.tar.gz -C /usr/local/lib/node_modules/xo-server-tag-automation/ --strip-components=1
   ```

5. Restart xo-server:
   ```bash
   sudo systemctl restart xo-server
   ```

6. Verify registration:
   ```bash
   sudo journalctl -u xo-server -n 100 --no-pager | grep -A3 "tag-automation"
   ```

   You should see:
     [INFO] xo-tag-automation: Plugin factory called -- xo context: YES
     [INFO] xo-tag-automation: Plugin loaded -- waiting for core started.
     xo:plugin INFO successfully register tag-automation

7. Enable and configure the plugin in XO:
     Settings -> Plugins -> tag-automation -> Enable
---

## Configuration

All settings are managed in the XO plugin UI under **Settings -> Plugins -> tag-automation**.

| Setting | Description | Default |
|---|---|---|
| **Tag Suffix** | Pool-specific suffix for tag matching (e.g. `-v`, `-1`). Leave blank for generic. | `-v` |
| **Enforcement Schedule** | How often to run Performance, CSV Sync, and Autopilot (`hourly`, `daily`, `disabled`). | `daily` |
| **Dry-Run / Export-CSV** | Preview changes and export CSV without applying anything. | `true` |
| **Enable Performance Sync** | Apply CPU weights and IO priorities from tier tags. | `false` |
| **Enable Permission Sync** | Create groups and apply ACLs from permission tags. | `false` |
| **Enable Permission Autopilot** | Apply permissions from CSV on schedule. Disable when not actively migrating VMs. | `false` |
| **NFS Share Path** | Base path to your NFS share directory. All plugin files are managed here automatically. | *(set to your mount point)* |
| **CSV Age Warning (days)** | Warn in logs if `current-vms.csv` has not been refreshed in this many days. | `7` |
| **Performance Tier Settings** | CPU weights and IO priorities per tier (Core / High / Normal / Low). | See table above |

> **Note:** The **Delete configuration** button resets all plugin settings to their defaults. It does not delete any VMs, tags, groups, or CSV files on your NFS share. It is safe to use if you want to reset the plugin configuration.

---

## CSV Workflow

### CSV Format

```
# Updated: YYYY-MM-DD | VMs: N | Pool: -v
UUID,Name,CurrentTags,NewTags,CurrentNotes,NewNotes
<uuid>,<vm-name>,<current-tags>,,<current-notes>,
```

- Tags are semicolon-separated: `2-normal-v;MyProject-Operator`
- `NewTags` are **additive** -- they add to existing tags, never replace
- `CurrentTags` and `CurrentNotes` are read-only -- refreshed automatically on every run
- `NewTags` and `NewNotes` are cleared after being applied

### Initial Export

1. Set **Dry-Run ON** and click **Run Now** (or wait for the scheduled run).
2. The plugin exports `current-vms.csv` to your NFS share with all current VM data.
3. `NewTags` and `NewNotes` columns will be blank and ready to fill in.

### Applying Changes

1. Edit `current-vms.csv` on your NFS share -- add tags to `NewTags`, notes to `NewNotes`.
2. Set **Dry-Run OFF**.
3. Click **Run Now** to apply changes.
4. The CSV auto-refreshes: `CurrentTags` and `CurrentNotes` update, `NewTags` and `NewNotes` clear.

### Transferring CSV Files via SCP

Admins can securely transfer CSV files to/from the XOA without direct NFS access:

```bash
# Download CSV from XOA to your workstation
scp <xoa-user>@<xoa-ip>:/path/to/current-vms.csv ./

# Upload edited CSV back to XOA
scp ./current-vms.csv <xoa-user>@<xoa-ip>:/path/to/current-vms.csv
```

Or use the xo-cli API methods (see below).

### Preload Workflow

1. Create `preload-vms.csv` on your NFS share with columns: `Name`, `Tags`, `Notes`.
2. Add rows for VMs that will be migrated or created.
3. When a matching VM appears in XO, the plugin applies its tags and notes automatically and removes the row from the preload file.

---

## Performance Tiers

Tag your VMs with a tier tag plus your configured suffix to set CPU scheduling priority:

```
0-core-v    ->  CPU weight: 2048  |  IO priority: 7  (highest)
1-high-v    ->  CPU weight: 1024  |  IO priority: 7
2-normal-v  ->  CPU weight: 512   |  IO priority: 5
3-low-v     ->  CPU weight: 256   |  IO priority: 2  (lowest)
```

*(Example uses suffix `-v`. Adjust to match your configured Tag Suffix.)*

All weights and priorities are configurable in the plugin UI under **Performance Tier Settings**.

---

## Permission Sync and Autopilot

### Tag-Driven Permissions

Tag a VM with a group name ending in `-Admin`, `-Operator`, or `-Viewer`:

```
MyProject-Admin     ->  Creates group "MyProject-Admin"     ->  Grants admin ACL on VM
MyProject-Operator  ->  Creates group "MyProject-Operator"  ->  Grants operator ACL on VM
MyProject-Viewer    ->  Creates group "MyProject-Viewer"    ->  Grants viewer ACL on VM
```

Role suffixes are hardcoded (`-Admin`, `-Operator`, `-Viewer`) to prevent mis-assignment with sub-department names.

### Permission Autopilot

When enabled, Autopilot reads permission tags from two sources:

1. `current-vms.csv` -- matched by UUID, reads `CurrentTags` column
2. `preload-vms.csv` -- matched by VM name, reads `Tags` column

> **Recommendation:** Disable Autopilot when not actively performing VM migrations or onboarding projects.

---

## xo-cli API Methods

The plugin exposes the following API methods via xo-cli:

```bash
# Export current VM inventory to current-vms.csv
xo-cli xo-server-tag-automation.exportCsv

# Print CSV content to stdout
xo-cli xo-server-tag-automation.downloadCsvApi

# Push an edited CSV back to the NFS share
xo-cli xo-server-tag-automation.uploadCsvApi content@./current-vms.csv

# View the last N lines of the plugin log
xo-cli xo-server-tag-automation.getLog lines=100

# View the run summary log
xo-cli xo-server-tag-automation.getSummaryLog lines=50

# View the nightly VM count summary
xo-cli xo-server-tag-automation.getDailySummary

# Write the daily summary immediately (without waiting for midnight)
xo-cli xo-server-tag-automation.writeDailySummaryNow

# Show all configured file paths
xo-cli xo-server-tag-automation.getFilePaths

# Trigger a CSV sync run
xo-cli xo-server-tag-automation.runSync
```

---

## Logging

All log files are written to the `logs/` subdirectory of your configured NFS share path:

| File | Description |
|---|---|
| `xo-tag-automation.log` | Full run log. Auto-rotates at 2MB; previous log saved as `.log.1`. |
| `xo-tag-automation.log.1` | Previous log backup (one generation kept). |
| `xo-tag-automation-summary.log` | Summary-level entries only -- one block per run. |
| `daily-summary.log` | Written at midnight. Total VM count and newly detected VMs for the day. |

---

## Changelog

### v0.7.9 (2026-06-07) -- First Official Public Release
- First official public release of the plugin
- Airgap bundle verified: pre-built `dist/index.js`, vendored `node_modules`, valid `.babelrc`
- Added `build-release.sh` pre-pack verification script
- README updated with full documentation, security guidance, and complete changelog

### v0.7.8
- Removed `lastDailySummary` field from plugin UI (configuration schema)
- Daily summary backend fully retained: `writeDailySummary()` still runs at midnight
- `getDailySummary` and `writeDailySummaryNow` API methods still available
- `package.json` updated: June 6

### v0.7.7
- Updated all plugin UI field descriptions for clarity
- `enablePermissionAutopilot` description expanded with full usage guidance
- `tagSuffix`, `schedule`, and `nfsSharePath` descriptions refined

### v0.7.6
- Added daily summary backend: `writeDailySummary()` runs at midnight via dedicated scheduler
- Added `getDailySummary` and `writeDailySummaryNow` API methods
- Simplified Permission Autopilot toggle: controlled solely by `enablePermissionAutopilot`
- Added midnight scheduler (`cron: 0 0 * * *`) independent of main enforcement schedule

### v0.7.3
- Fixed CSV/preload processing bugs
- `enforcePermissionsFromCsv` now reads from both `current-vms.csv` (by UUID) and `preload-vms.csv` (by VM name)
- Improved preload row cleanup: duplicate detection, already-done detection, pending row retention

### v0.7.0
- Renamed `vm_metadata.csv` to `current-vms.csv` (breaking change -- auto-migration included)
- Added `migrateVmMetadataCsv()` for automatic legacy file rename on first run
- Introduced `preload-vms.csv` pre-loader workflow

### v0.5.4
- Added `getVmNotes()` fallback chain: `name_description` -> `notes` -> `other_config.notes` -> `other_config.description`

### v0.5.3
- Hardened `isRealVm()` filter with multi-gate checks
- Excludes templates, control domains, backup VMs, V2V import artifacts, ESXI imports, and ISO/VMDK names

### v0.3.2
- package.json version bump
- Change-Log added to knowledge bank

### v0.1.0 -- v0.3.1
- Initial plugin architecture: performance enforcement, permission sync, CSV export/import
- NFS logging, dry-run mode, Run Now action, xo-cli API methods
- Hardcoded role suffixes (`-Admin`, `-Operator`, `-Viewer`) to prevent mis-assignment

### Shell Script Bundle (Pre-Plugin Era)

| Version | Date | Notes |
|---|---|---|
| v1.8 | 2026-05 | Hardcoded role suffixes; configurable suffixes removed |
| v1.7 | 2026-05 | TAG_PREFIX concept removed; role detection made case-insensitive |
| v1.0 | 2026-05-16 | Initial public release: export / dry-run / sync modes, CSV format, xe tag application |

---

## Credits

- Inspired by the *A Tale of Two Servers* series by Tobias Kreidl
- [Archive and Summary Reference](https://github.com/johnezero/A-Tale-of-Two-Servers_archive/blob/main/tale-of-two-servers_summary-xcpng-quick-reference.md)
- [Vates REST API Documentation](https://xen-orchestra.com/docs/restapi.html)

---

## License

MIT -- see [LICENSE](LICENSE)

---

## Disclaimer

This is a community-developed plugin, not an official Vates product. Always test in a lab or staging environment before deploying to production. The author is not responsible for unintended changes to VM configurations. Use Dry-Run mode to preview all changes before applying them.

---

*Feedback, issues, and pull requests welcome:*
*[github.com/johnezero/xo-tag-automation_plugin](https://github.com/johnezero/xo-tag-automation_plugin)*

---

<img src="https://raw.githubusercontent.com/johnezero/xo-tag-automation_plugin/main/assets/logo.png" alt="Anything and Everything to Make XCP-ng Better" width="350" align="left">
