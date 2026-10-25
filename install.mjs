#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE = 'web';

function parseArgs(argv) {
  const opts = { dshHome: '', profile: DEFAULT_PROFILE, force: false, skipSync: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dsh-home') opts.dshHome = argv[++i] || '';
    else if (arg === '--profile') opts.profile = argv[++i] || '';
    else if (arg === '--force') opts.force = true;
    else if (arg === '--skip-sync') opts.skipSync = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!opts.profile) throw new Error('--profile requires a profile name');
  return opts;
}

function help() {
  console.log(`Stage the cockpit-tools DSH bundle and skill into a DSH home.

Usage:
  node install.mjs [--dsh-home <path>] [--profile <name>] [--skip-sync] [--force]

Options:
  --dsh-home <path>  DSH home (default: DSH_HOME or ~/.dsh)
  --profile <name>   Profile name for the printed install command (default: web)
  --skip-sync        Stage files only; do not contact cockpit-tools or write credentials
  --force            Back up existing staged folders before copying this release
  --help             Show this help

The installer stages the local bundle and skill. It does not install into or restart a DSH profile.
`);
}

function copyTree(source, destination, force) {
  if (!fs.existsSync(source)) throw new Error(`Package source is missing: ${source}`);
  if (fs.existsSync(destination)) {
    if (!force) throw new Error(`Destination exists: ${destination}\nUse --force to back it up and update the staged package.`);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const backup = `${destination}.bak.${stamp}`;
    fs.cpSync(destination, backup, { recursive: true, errorOnExist: true });
    console.log(`Backup: ${backup}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function main() {
  if (process.versions.node.split('.')[0] < 18) throw new Error('Node.js 18 or later is required.');
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return help();

  const dshHome = path.resolve(opts.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const bundleSource = path.join(ROOT, 'bundle');
  const skillSource = path.join(ROOT, 'skills', 'cockpit-tools-model-sync');
  const bundleTarget = path.join(dshHome, 'cockpit-tools-provider');
  const skillTarget = path.join(dshHome, 'skills', 'cockpit-tools-model-sync');

  copyTree(bundleSource, bundleTarget, opts.force);
  copyTree(skillSource, skillTarget, opts.force);
  console.log(`Bundle staged: ${bundleTarget}`);
  console.log(`Skill staged:  ${skillTarget}`);

  if (!opts.skipSync) {
    const syncScript = path.join(bundleTarget, 'sync-cockpit-models.mjs');
    const sync = spawnSync(process.execPath, [
      syncScript,
      '--dsh-home', dshHome,
      '--patch', path.join(bundleTarget, 'cordis.patch.yml'),
      '--profile', opts.profile,
    ], { stdio: 'inherit' });
    if (sync.error) throw sync.error;
    if (sync.status !== 0) {
      console.error(`Staging succeeded, but initial model sync failed (exit ${sync.status ?? 'unknown'}). Start cockpit-tools and run the sync command shown below.`);
      process.exitCode = sync.status || 1;
      return;
    }
  } else {
    console.log('Initial model sync skipped. The bundle contains the included sample catalog and endpoint port.');
  }

  console.log('\nInstall the staged configuration bundle in the target profile:');
  console.log(`  dsh plugin --profile ${opts.profile} add "${bundleTarget}"`);
  console.log('For DSH Desktop, use the Plugins page → Install third-party plugin and select that folder,');
  console.log('or ask the Desktop plugin_manager to install_bundle with this absolute directory.');
  console.log('The separate skill is already copied to the DSH user skill root.');
}

try {
  main();
} catch (error) {
  console.error(`[cockpit-tools DSH package] ${error?.message || error}`);
  process.exitCode = 1;
}
