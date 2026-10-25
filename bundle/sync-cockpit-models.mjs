#!/usr/bin/env node
/**
 * sync-cockpit-models.mjs
 *
 * 把本地 cockpit-tools 反向代理的模型目录（GET /v1/models）同步到指定 DSH
 * profile 的 cordis.patch.yml 中 llm-pi-ai 条目下的标记块里：
 *
 *   # >>> cockpit-tools-sync (auto-generated; run sync-cockpit-models.mjs to refresh) >>>
 *   # <<< cockpit-tools-sync <<<
 *
 * 只替换两条标记之间的文本；标记之外的 YAML、注释、空行与文件结尾换行原样保留。
 * 原子写入 + 带时间戳的 .bak 备份；默认不会覆盖已存在的凭据值，也从不打印 API key。
 *
 * 零外部依赖，要求 Node.js >= 18（使用全局 fetch）。
 * 用法与规则见同目录 README.md。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);

const PROVIDER_ID = 'cockpit-tools';
const API_KEY_ENV = 'COCKPIT_TOOLS_API_KEY';
const DISPLAY_NAME = 'Cockpit Tools 反代';
const API_KIND = 'openai-responses';
const DEFAULT_CONTEXT_WINDOW = 272000;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_REASONING = 'medium';
const DEFAULT_EXCLUDE_IDS = ['gpt-reserve'];
const DSH_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const OPEN_MARKER_PREFIX = '# >>> cockpit-tools-sync';
const CLOSE_MARKER = '# <<< cockpit-tools-sync <<<';
const FETCH_TIMEOUT_MS = 20000;
const NODE_MAJOR_REQUIRED = 18;

const MARKER_HINT =
  '请在 llm-pi-ai 条目的 config.providers 下加入（保留缩进）：\n' +
  '  # >>> cockpit-tools-sync (auto-generated; run sync-cockpit-models.mjs to refresh) >>>\n' +
  '  # <<< cockpit-tools-sync <<<';

const HELP = `同步 cockpit-tools 反代模型目录到指定 DSH profile 配置

用法:
  node sync-cockpit-models.mjs [选项]

数据来源:
  GET <baseURL>/models（Bearer 鉴权）。默认按顺序查找 cockpit 配置:
    ~/.cockpit_tools/codex_local_access.json
    ~/.antigravity_cockpit/codex_local_access.json
  从中读取 port 与 apiKey；可用 --port / --api-key / --base-url 覆盖。

目标:
  默认 <DSH_HOME>/profiles/<profile>/cordis.patch.yml 中 llm-pi-ai 条目内
  "# >>> cockpit-tools-sync ... >>>" 与 "# <<< cockpit-tools-sync <<<" 之间的内容。
  只替换标记之间的文本，标记之外的 YAML 原样保留。

模式:
  （默认）              需要时写入补丁/凭据，并生成带时间戳的 .bak 备份
  --dry-run             只打印将生成的标记块与变更摘要，不写入任何文件
  --check               不写入：已同步退出 0，需要更新退出 2，错误退出 1
  --json                输出机器可读 JSON（stdout 仅一个 JSON 对象）
  --quiet               精简输出（错误仍写入 stderr；dry-run 不打印完整标记块）

覆盖项:
  --port <数字>          cockpit-tools 端口
  --api-key <key>        cockpit-tools API key（不会出现在任何日志中）
  --base-url <url>       API base URL，需包含 /v1（如 http://127.0.0.1:51894/v1）
  --cockpit-config <f>   指定 cockpit codex_local_access.json 路径
  --catalog <file>       离线模式：从 JSON 文件读取模型目录（测试/回放用）
  --dsh-home <dir>       DSH home（默认 $DSH_HOME 或 ~/.dsh）
  --patch <file>         cordis.patch.yml 路径
  --profile <name>       DSH profile 名（默认 web）

排除:
  --exclude <ids>        额外排除的模型 id，逗号分隔，可重复
  --exclude-file <file>  排除文件路径（默认：与本脚本同目录的 models-exclude.json）
  --no-exclude           忽略排除文件（不加载默认排除；--exclude 仍生效）

凭据:
  --no-credentials       不读取、不写入 .credentials.yaml

其他:
  -h, --help             显示本帮助

退出码:
  0  成功；或 --check 时已同步
  2  --check 时需要更新
  1  错误（配置缺失、网络/鉴权失败、标记缺失、排除文件损坏等）

示例:
  node sync-cockpit-models.mjs --dry-run
  node sync-cockpit-models.mjs --check
  node sync-cockpit-models.mjs
  node sync-cockpit-models.mjs --json --check
`;

class SyncError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.hint = hint || '';
  }
}

function usageError(message) {
  return new SyncError('EUSAGE', message, '使用 --help 查看完整用法。');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    help: false,
    dryRun: false,
    check: false,
    json: false,
    quiet: false,
    port: null,
    apiKey: null,
    baseUrl: null,
    cockpitConfig: null,
    catalog: null,
    dshHome: null,
    patch: null,
    profile: 'web',
    excludeIds: [],
    excludeFile: null,
    noExclude: false,
    noCredentials: false,
  };

  const valueFlags = new Set([
    '--port',
    '--api-key',
    '--base-url',
    '--cockpit-config',
    '--catalog',
    '--dsh-home',
    '--patch',
    '--profile',
    '--exclude',
    '--exclude-file',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('-')) throw usageError(`无法识别的参数: ${raw}`);
    let flag = raw;
    let inlineValue = null;
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      if (eq !== -1) {
        flag = raw.slice(0, eq);
        inlineValue = raw.slice(eq + 1);
      }
    }

    if (flag === '-h' || flag === '--help') {
      if (inlineValue !== null) throw usageError(`${flag} 不接受取值。`);
      opts.help = true;
      continue;
    }
    if (flag === '--dry-run') {
      if (inlineValue !== null) throw usageError('--dry-run 不接受取值。');
      opts.dryRun = true;
      continue;
    }
    if (flag === '--check') {
      if (inlineValue !== null) throw usageError('--check 不接受取值。');
      opts.check = true;
      continue;
    }
    if (flag === '--json') {
      if (inlineValue !== null) throw usageError('--json 不接受取值。');
      opts.json = true;
      continue;
    }
    if (flag === '--quiet') {
      if (inlineValue !== null) throw usageError('--quiet 不接受取值。');
      opts.quiet = true;
      continue;
    }
    if (flag === '--no-exclude') {
      if (inlineValue !== null) throw usageError('--no-exclude 不接受取值。');
      opts.noExclude = true;
      continue;
    }
    if (flag === '--no-credentials') {
      if (inlineValue !== null) throw usageError('--no-credentials 不接受取值。');
      opts.noCredentials = true;
      continue;
    }

    if (!valueFlags.has(flag)) throw usageError(`未知选项: ${flag}`);

    let value = inlineValue;
    if (value === null) {
      i += 1;
      if (i >= argv.length) throw usageError(`${flag} 需要一个取值。`);
      value = argv[i];
    }
    if (value === '') throw usageError(`${flag} 的取值不能为空。`);

    switch (flag) {
      case '--port': {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw usageError('--port 必须是 1-65535 之间的整数。');
        }
        opts.port = port;
        break;
      }
      case '--api-key':
        opts.apiKey = value;
        break;
      case '--base-url':
        opts.baseUrl = value;
        break;
      case '--cockpit-config':
        opts.cockpitConfig = value;
        break;
      case '--catalog':
        opts.catalog = value;
        break;
      case '--dsh-home':
        opts.dshHome = value;
        break;
      case '--patch':
        opts.patch = value;
        break;
      case '--profile':
        if (!/^[A-Za-z0-9._-]+$/.test(value)) {
          throw usageError('--profile 只能包含字母、数字、点、下划线和连字符。');
        }
        opts.profile = value;
        break;
      case '--exclude':
        for (const id of value.split(',')) {
          const trimmed = id.trim();
          if (trimmed) opts.excludeIds.push(trimmed);
        }
        break;
      case '--exclude-file':
        opts.excludeFile = value;
        break;
      default:
        throw usageError(`未知选项: ${flag}`);
    }
  }

  if (opts.dryRun && opts.check) {
    throw usageError('--dry-run 与 --check 不能同时使用（两者都不写文件，但退出码语义不同）。');
  }
  if (opts.noExclude && opts.excludeFile) {
    throw usageError('--no-exclude 与 --exclude-file 不能同时使用。');
  }
  return opts;
}

function commandName(opts) {
  if (!opts) return 'unknown';
  if (opts.check) return 'check';
  if (opts.dryRun) return 'dry-run';
  return 'sync';
}

// ---------------------------------------------------------------------------
// Files / paths
// ---------------------------------------------------------------------------

function readTextFile(file, code, label, hint) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new SyncError(code, `无法读取${label}: ${file}（${err.message}）`, hint || '');
  }
}

function resolveTarget(opts) {
  const dshHome = path.resolve(
    opts.dshHome || process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  );
  const patchPath = opts.patch
    ? path.resolve(opts.patch)
    : path.join(dshHome, 'profiles', opts.profile, 'cordis.patch.yml');
  return {
    dshHome,
    patchPath,
    credentialsPath: path.join(dshHome, '.credentials.yaml'),
  };
}

function timestampNow() {
  const d = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function nextBackupPath(file, stamp) {
  let candidate = `${file}.bak.${stamp}`;
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = `${file}.bak.${stamp}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function atomicWriteWithBackup(file, content, stamp) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, content, 'utf8');
  let backup = null;
  if (existsSync(file)) {
    backup = nextBackupPath(file, stamp);
    copyFileSync(file, backup);
  }
  renameSync(tmp, file);
  return backup;
}

// ---------------------------------------------------------------------------
// Patch parsing / rendering
// ---------------------------------------------------------------------------

function splitPatch(text, patchPath) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  const openMatches = [];
  const closeMatches = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(OPEN_MARKER_PREFIX) && trimmed.endsWith('>>>')) {
      openMatches.push(index);
    }
    if (trimmed === CLOSE_MARKER) closeMatches.push(index);
  });

  if (openMatches.length === 0 || closeMatches.length === 0) {
    throw new SyncError(
      'EMARKERS',
      `补丁缺少 cockpit-tools-sync 标记块: ${patchPath}`,
      MARKER_HINT,
    );
  }
  if (openMatches.length > 1 || closeMatches.length > 1) {
    throw new SyncError(
      'EMARKERS',
      `补丁中 cockpit-tools-sync 标记出现多次（起始 ${openMatches.length} 处、结束 ${closeMatches.length} 处），拒绝猜测: ${patchPath}`,
      '请只保留一组标记。',
    );
  }
  const openIdx = openMatches[0];
  const closeIdx = closeMatches[0];
  if (closeIdx <= openIdx) {
    throw new SyncError(
      'EMARKERS',
      `cockpit-tools-sync 标记顺序错误（结束标记位于起始标记之前）: ${patchPath}`,
      MARKER_HINT,
    );
  }

  const openIndent = (lines[openIdx].match(/^[ ]*/) || [''])[0];
  const closeIndent = (lines[closeIdx].match(/^[ ]*/) || [''])[0];
  if (openIndent.length === 0) {
    throw new SyncError(
      'EMARKERS',
      `cockpit-tools-sync 起始标记必须带缩进（应位于 llm-pi-ai 的 providers 下）: ${patchPath}`,
      MARKER_HINT,
    );
  }
  if (openIndent !== closeIndent) {
    throw new SyncError(
      'EMARKERS',
      `cockpit-tools-sync 起始与结束标记缩进不一致: ${patchPath}`,
      MARKER_HINT,
    );
  }

  const llmIdx = lines.findIndex((line) => /^-\s+id:\s*llm-pi-ai\s*$/.test(line.trim()));
  if (llmIdx === -1) {
    throw new SyncError(
      'EENTRY',
      `补丁中找不到 llm-pi-ai 条目: ${patchPath}`,
      '请确认 patch 中存在 "- id: llm-pi-ai" 条目，并带有 config.providers 配置。',
    );
  }
  if (openIdx < llmIdx) {
    throw new SyncError(
      'EMARKERS',
      `cockpit-tools-sync 标记块位于 llm-pi-ai 条目之前: ${patchPath}`,
      MARKER_HINT,
    );
  }

  let providersSeen = false;
  for (let i = llmIdx + 1; i < openIdx; i += 1) {
    const trimmed = lines[i].trim();
    if (/^-\s+id:\s*\S+/.test(trimmed)) {
      throw new SyncError(
        'EMARKERS',
        `cockpit-tools-sync 标记块不属于 llm-pi-ai 条目（中间出现了其他条目）: ${patchPath}`,
        MARKER_HINT,
      );
    }
    if (trimmed === 'providers:') providersSeen = true;
  }
  if (!providersSeen) {
    throw new SyncError(
      'EENTRY',
      `llm-pi-ai 条目下找不到 providers: 配置: ${patchPath}`,
      '标记块必须位于 llm-pi-ai 条目的 config.providers 下。',
    );
  }

  return {
    eol,
    lines,
    openIdx,
    closeIdx,
    indent: openIndent,
    openLine: lines[openIdx],
    closeLine: lines[closeIdx],
  };
}

function yamlScalar(value) {
  const s = String(value);
  if (s === '') return '""';
  const safe =
    /^[A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5 .\-_+&()/%]*$/u.test(s) &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(s);
  return safe ? s : JSON.stringify(s);
}

function yamlUrl(value) {
  const s = String(value);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s#'"]*$/.test(s)) return s;
  return JSON.stringify(s);
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function renderBlock(indent, models, baseUrl) {
  const field = `${indent}  `;
  const item = `${field}  `;
  const attr = `${item}  `;
  const lines = [];
  lines.push(`${indent}${PROVIDER_ID}:`);
  lines.push(`${field}displayName: ${DISPLAY_NAME}`);
  lines.push(`${field}api: ${API_KIND}`);
  lines.push(`${field}baseURL: ${yamlUrl(baseUrl)}`);
  lines.push(`${field}apiKeyEnv: ${API_KEY_ENV}`);
  lines.push(`${field}defaultContextWindow: ${DEFAULT_CONTEXT_WINDOW}`);
  lines.push(`${field}defaultMaxTokens: ${DEFAULT_MAX_TOKENS}`);
  lines.push(`${field}reasoning: ${DEFAULT_REASONING}`);
  lines.push(`${field}models:`);
  for (const model of models) {
    lines.push(`${item}- id: ${yamlScalar(model.id)}`);
    lines.push(`${attr}name: ${yamlScalar(model.name)}`);
    lines.push(`${attr}contextWindow: ${model.contextWindow}`);
    lines.push(`${attr}input: [${model.input.join(', ')}]`);
    if (model.reasoningEfforts === false) {
      lines.push(`${attr}reasoningEfforts: false`);
    } else {
      lines.push(`${attr}reasoningEfforts:`);
      for (const level of model.reasoningEfforts) {
        lines.push(`${attr}  ${level}: ${level}`);
      }
    }
  }
  return lines;
}

function validateBlock(lines, indent) {
  const fail = (message) =>
    new SyncError('EINVALID_RESULT', `生成的标记块校验失败：${message}；拒绝写入。`);

  if (!Array.isArray(lines) || lines.length === 0) throw fail('标记块为空');
  for (const line of lines) {
    if (typeof line !== 'string' || line.trim() === '') throw fail('存在空行或非法行');
    if (line.includes('\t')) throw fail('包含制表符');
    if (!line.startsWith(indent)) throw fail('缩进不一致');
  }
  if (lines[0] !== `${indent}${PROVIDER_ID}:`) throw fail('首行不是 cockpit-tools:');

  const modelsLine = `${indent}  models:`;
  const modelsIdx = lines.indexOf(modelsLine);
  if (modelsIdx === -1) throw fail('缺少 models: 行');

  const itemIndent = `${indent}    `;
  const idPrefix = `${itemIndent}- id: `;
  const idLines = lines.filter((line) => line.startsWith(idPrefix));
  if (idLines.length === 0) throw fail('没有模型 id');
  const ids = idLines.map((line) => line.slice(idPrefix.length).trim());
  if (ids.some((id) => id === '')) throw fail('存在空模型 id');
  if (new Set(ids).size !== ids.length) throw fail('模型 id 重复');

  const firstIdIdx = lines.findIndex((line) => line.startsWith(idPrefix));
  if (modelsIdx > firstIdIdx) throw fail('models: 行位于模型条目之后');

  const attrIndent = `${itemIndent}  `;
  for (const fieldName of ['name: ', 'contextWindow: ', 'input: ']) {
    const count = lines.filter((line) => line.startsWith(`${attrIndent}${fieldName}`)).length;
    if (count !== ids.length) throw fail(`字段 ${fieldName.trim()} 数量与模型数量不一致`);
  }
  const reasoningFlags = lines.filter(
    (line) =>
      line === `${attrIndent}reasoningEfforts: false` ||
      line === `${attrIndent}reasoningEfforts:`,
  ).length;
  if (reasoningFlags !== ids.length) throw fail('reasoningEfforts 数量与模型数量不一致');
  return true;
}

function extractField(blockLines, fieldName) {
  const re = new RegExp(`^[ ]*${fieldName}:[ ]*(.*)$`);
  for (const line of blockLines) {
    const match = line.match(re);
    if (match) return match[1].trim();
  }
  return null;
}

function parseEntries(blockLines) {
  const entries = new Map();
  let current = null;
  let currentIndent = -1;
  for (const line of blockLines) {
    const match = line.match(/^([ ]*)-[ ]+id:[ ]*(.+?)[ ]*$/);
    if (match) {
      currentIndent = match[1].length;
      current = { id: match[2], lines: [line] };
      entries.set(match[2], current);
      continue;
    }
    if (current) {
      const leading = (line.match(/^[ ]*/) || [''])[0].length;
      if (line.trim() !== '' && leading < currentIndent) {
        current = null;
      } else if (line.trim() !== '') {
        current.lines.push(line);
      }
    }
  }
  return entries;
}

function diffBlock(oldBlockLines, newBlockLines) {
  const oldEntries = parseEntries(oldBlockLines);
  const newEntries = parseEntries(newBlockLines);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, entry] of newEntries) {
    const oldEntry = oldEntries.get(id);
    if (!oldEntry) added.push(id);
    else if (oldEntry.lines.join('\n') !== entry.lines.join('\n')) changed.push(id);
  }
  for (const id of oldEntries.keys()) {
    if (!newEntries.has(id)) removed.push(id);
  }
  const oldBase = extractField(oldBlockLines, 'baseURL');
  const newBase = extractField(newBlockLines, 'baseURL');
  return {
    added,
    removed,
    changed,
    baseURL: { from: oldBase, to: newBase, changed: oldBase !== newBase },
  };
}

// ---------------------------------------------------------------------------
// Cockpit config / endpoint
// ---------------------------------------------------------------------------

function loadCockpitConfig(opts) {
  const explicit = opts.cockpitConfig ? path.resolve(opts.cockpitConfig) : null;
  const candidates = explicit
    ? [explicit]
    : [
        path.join(homedir(), '.cockpit_tools', 'codex_local_access.json'),
        path.join(homedir(), '.antigravity_cockpit', 'codex_local_access.json'),
      ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const raw = readTextFile(
      file,
      'ECOCKPIT_CONFIG',
      'cockpit 配置',
      '请检查该 JSON 文件，或使用 --port / --api-key 覆盖。',
    );
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new SyncError(
        'ECOCKPIT_CONFIG',
        `cockpit 配置不是合法 JSON: ${file}（${err.message}）`,
        '请检查该文件，或使用 --port / --api-key 覆盖。',
      );
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new SyncError(
        'ECOCKPIT_CONFIG',
        `cockpit 配置结构异常（应为 JSON 对象）: ${file}`,
        '请检查该文件，或使用 --port / --api-key 覆盖。',
      );
    }
    return { path: file, data };
  }

  if (explicit) {
    throw new SyncError(
      'ECOCKPIT_CONFIG',
      `--cockpit-config 指定的文件不存在: ${explicit}`,
      '请检查路径，或改用 --port / --api-key。',
    );
  }
  return null;
}

function resolveEndpoint(opts, cockpit, target) {
  const cockpitData = cockpit ? cockpit.data : null;
  const configPort =
    cockpitData && Number.isInteger(cockpitData.port) ? cockpitData.port : null;
  const configKey =
    cockpitData && typeof cockpitData.apiKey === 'string' && cockpitData.apiKey
      ? cockpitData.apiKey
      : null;

  const port = opts.port !== null ? opts.port : configPort;
  const apiKey = opts.apiKey || configKey;

  let baseUrl = null;
  if (opts.baseUrl) {
    baseUrl = opts.baseUrl.replace(/\/+$/, '');
  } else if (port) {
    baseUrl = `http://127.0.0.1:${port}/v1`;
  }

  if (!baseUrl) {
    throw new SyncError(
      'EENDPOINT',
      '无法确定 cockpit-tools 端点：未找到 cockpit 配置，也没有 --port / --base-url。',
      `请确认 ${path.join(homedir(), '.cockpit_tools', 'codex_local_access.json')} 存在，或显式传 --base-url http://127.0.0.1:51894/v1。`,
    );
  }

  return {
    port,
    apiKey,
    baseUrl,
    cockpitConfigPath: cockpit ? cockpit.path : null,
    apiKeySource: opts.apiKey
      ? 'cli'
      : configKey
        ? 'cockpit-config'
        : null,
  };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function validateCatalog(data, sourceLabel) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.data)) {
    throw new SyncError(
      'ECATALOG',
      `模型目录结构异常（缺少 data 数组）: ${sourceLabel}`,
      '期望 GET /v1/models 返回 { data: [...], models: [...], object }。',
    );
  }
  if (data.data.length === 0) {
    throw new SyncError(
      'ECATALOG',
      `模型目录为空: ${sourceLabel}`,
      '请确认 cockpit-tools 已登录账号，且 /v1/models 返回模型列表。',
    );
  }
}

async function loadCatalog(opts, endpoint) {
  if (opts.catalog) {
    const file = path.resolve(opts.catalog);
    if (!existsSync(file)) {
      throw new SyncError(
        'ECATALOG',
        `--catalog 指定的文件不存在: ${file}`,
        '--catalog 仅用于离线测试/回放。',
      );
    }
    const raw = readTextFile(file, 'ECATALOG', '--catalog 文件');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new SyncError('ECATALOG', `--catalog 文件不是合法 JSON: ${file}（${err.message}）`);
    }
    validateCatalog(data, file);
    return { data, source: `file:${file}`, count: data.data.length };
  }

  if (!endpoint.apiKey) {
    throw new SyncError(
      'EAUTH',
      '缺少 cockpit-tools API key，无法请求 /v1/models。',
      `请确认 cockpit 配置中有 apiKey（或 refs.${API_KEY_ENV}），也可用 --api-key 指定。`,
    );
  }

  const url = `${endpoint.baseUrl}/models`;
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${endpoint.apiKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err && err.cause && err.cause.code ? ` ${err.cause.code}` : '';
    throw new SyncError(
      'ECATALOG_FETCH',
      `无法连接 cockpit-tools 反代: ${url}${cause}`,
      '请确认 cockpit-tools 正在运行、端口正确（可用 --port 覆盖），或先启动 cockpit-tools。',
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new SyncError(
      'EAUTH',
      `模型目录请求鉴权失败: HTTP ${response.status}`,
      `API key 无效或已轮换。请检查 cockpit 配置里的 apiKey，或使用 --api-key 覆盖；本工具不会打印 key。`,
    );
  }
  if (response.status === 404) {
    throw new SyncError(
      'ECATALOG_FETCH',
      `模型目录接口不存在: HTTP 404 ${url}`,
      '请确认 base URL 含 /v1（如 http://127.0.0.1:51894/v1）。',
    );
  }
  if (!response.ok) {
    throw new SyncError(
      'ECATALOG_FETCH',
      `模型目录请求失败: HTTP ${response.status} ${response.statusText}`.trim(),
      '请检查 cockpit-tools 服务状态与版本。',
    );
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    throw new SyncError('ECATALOG_FETCH', `读取模型目录响应失败: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new SyncError(
      'ECATALOG',
      `模型目录响应不是合法 JSON: ${err.message}`,
      '请检查 cockpit-tools 版本或反向代理是否返回了错误页面。',
    );
  }
  validateCatalog(data, `${endpoint.baseUrl}/models`);
  return { data, source: `${endpoint.baseUrl}/models`, count: data.data.length };
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

function mapCatalog(catalog, excludeSet) {
  const fullBySlug = new Map();
  if (Array.isArray(catalog.models)) {
    for (const full of catalog.models) {
      if (full && typeof full === 'object' && typeof full.slug === 'string') {
        fullBySlug.set(full.slug, full);
      }
    }
  }

  const models = [];
  const excluded = [];
  const seen = new Set();

  for (const raw of catalog.data) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) continue;

    const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities : [];
    if (!capabilities.includes('completion')) {
      excluded.push({ id, reason: 'no-completion-capability' });
      continue;
    }

    const full = fullBySlug.get(id);
    const visibility =
      full && typeof full.visibility === 'string'
        ? full.visibility
        : typeof raw.visibility === 'string'
          ? raw.visibility
          : 'list';
    if (visibility === 'hide') {
      excluded.push({ id, reason: 'visibility-hide' });
      continue;
    }

    if (excludeSet.has(id)) {
      excluded.push({ id, reason: 'exclude-list' });
      continue;
    }

    if (seen.has(id)) continue;
    seen.add(id);

    const info =
      raw.model_info && typeof raw.model_info === 'object' && !Array.isArray(raw.model_info)
        ? raw.model_info
        : {};
    const contextWindow =
      positiveInt(info.context_length) ||
      positiveInt(raw.context_length) ||
      DEFAULT_CONTEXT_WINDOW;

    let input = Array.isArray(info.input_modalities)
      ? info.input_modalities.filter((modality) => modality === 'text' || modality === 'image')
      : [];
    input = [...new Set(input)];
    if (input.length === 0) input = ['text'];

    let reasoningEfforts = false;
    if (capabilities.includes('thinking')) {
      const supported = Array.isArray(info.supported_reasoning_efforts)
        ? info.supported_reasoning_efforts.filter((level) => typeof level === 'string')
        : [];
      const mapped = DSH_REASONING_LEVELS.filter((level) => supported.includes(level));
      if (mapped.length > 0) reasoningEfforts = mapped;
    }

    const name =
      typeof raw.display_name === 'string' && raw.display_name.trim()
        ? raw.display_name.trim()
        : id;

    models.push({ id, name, contextWindow, input, reasoningEfforts });
  }

  return { models, excluded };
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

function loadExcludes(opts) {
  const explicit = Boolean(opts.excludeFile);
  const file = explicit
    ? path.resolve(opts.excludeFile)
    : path.join(SCRIPT_DIR, 'models-exclude.json');

  const info = {
    file,
    explicit,
    source: 'none',
    fileExists: false,
    pendingCreate: false,
    ids: [],
  };

  if (!opts.noExclude) {
    if (existsSync(file)) {
      info.fileExists = true;
      const raw = readTextFile(
        file,
        'EEXCLUDE_FILE',
        '排除文件',
        `请把它修复为 JSON 字符串数组，例如 ["gpt-reserve"]。`,
      );
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new SyncError(
          'EEXCLUDE_FILE',
          `排除文件不是合法 JSON: ${file}（${err.message}）`,
          '请把它修复为 JSON 字符串数组，例如 ["gpt-reserve"]；或删除该文件以恢复默认排除。',
        );
      }
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new SyncError(
          'EEXCLUDE_FILE',
          `排除文件必须是 JSON 字符串数组: ${file}`,
          '请把它修复为 JSON 字符串数组，例如 ["gpt-reserve"]；或删除该文件以恢复默认排除。',
        );
      }
      info.ids = parsed.map((item) => item.trim());
      info.source = file;
    } else if (explicit) {
      throw new SyncError(
        'EEXCLUDE_FILE',
        `--exclude-file 指定的文件不存在: ${file}`,
        '如需创建，请写入 JSON 字符串数组，例如 ["gpt-reserve"]；或省略 --exclude-file 使用默认位置。',
      );
    } else {
      info.ids = [...DEFAULT_EXCLUDE_IDS];
      info.source = 'builtin-default';
      info.pendingCreate = true;
    }
  } else {
    info.source = 'disabled';
  }

  info.ids = [...new Set([...info.ids, ...opts.excludeIds])];
  return info;
}

function excludeReasonLabel(reason) {
  switch (reason) {
    case 'visibility-hide':
      return 'visibility=hide';
    case 'exclude-list':
      return '排除清单';
    case 'no-completion-capability':
      return '非 completion';
    default:
      return reason;
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function insertCredentialsRef(rawText, apiKey) {
  const eol = rawText.includes('\r\n') ? '\r\n' : '\n';
  const keyLine = `  ${API_KEY_ENV}: ${yamlScalar(apiKey)}`;

  if (rawText === '') {
    return ['version: 1', 'refs:', keyLine].join(eol) + eol;
  }

  const lines = rawText.split(/\r?\n/);
  const refsIdx = lines.findIndex((line) => /^refs:[ ]*(#.*)?$/.test(line));
  if (refsIdx === -1) {
    const hasTrailingEol = /\r?\n$/.test(rawText);
    const bodyLines = rawText.split(/\r?\n/);
    if (hasTrailingEol) bodyLines.pop();
    bodyLines.push('refs:', keyLine);
    return bodyLines.join(eol) + eol;
  }
  lines.splice(refsIdx + 1, 0, keyLine);
  return lines.join(eol);
}

function planCredentials(opts, target, apiKey) {
  const plan = {
    enabled: !opts.noCredentials,
    path: target.credentialsPath,
    exists: false,
    hasRef: false,
    willAdd: false,
    content: null,
    apiKey,
    action: 'skipped-disabled',
  };
  if (opts.noCredentials) return plan;

  plan.exists = existsSync(target.credentialsPath);
  let text = '';
  if (plan.exists) {
    text = readTextFile(
      target.credentialsPath,
      'ECREDENTIALS',
      '凭据文件',
      '检查文件权限，或使用 --no-credentials 跳过凭据同步。',
    );
    plan.hasRef = new RegExp(`^[ \\t]*${API_KEY_ENV}[ \\t]*:`, 'm').test(text);
  }

  if (plan.hasRef) {
    plan.action = 'present';
    return plan;
  }
  if (!apiKey) {
    plan.action = 'skipped-no-key';
    return plan;
  }
  plan.willAdd = true;
  plan.content = insertCredentialsRef(text, apiKey);
  plan.action = 'add-ref';
  return plan;
}

function credentialsLabel(plan, wrote) {
  switch (plan.action) {
    case 'present':
      return `refs.${API_KEY_ENV} 已存在（不改动）`;
    case 'add-ref':
      return wrote && wrote.credentials
        ? `已补充 refs.${API_KEY_ENV}（值已隐藏）`
        : `将补充 refs.${API_KEY_ENV}（值已隐藏）`;
    case 'skipped-disabled':
      return '跳过（--no-credentials）';
    case 'skipped-no-key':
      return '跳过（未获取到 API key）';
    default:
      return plan.action;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function describeChanges(ctx) {
  if (ctx.inSyncOverall) return '无（标记块与凭据均已同步）';
  const parts = [];
  const diff = ctx.diff;
  if (diff.added.length) parts.push(`+新增 ${diff.added.length} 个: ${diff.added.join(', ')}`);
  if (diff.removed.length) {
    parts.push(`-移除 ${diff.removed.length} 个: ${diff.removed.join(', ')}`);
  }
  if (diff.changed.length) {
    parts.push(`~修改 ${diff.changed.length} 个: ${diff.changed.join(', ')}`);
  }
  if (diff.baseURL.changed) {
    parts.push(`baseURL: ${diff.baseURL.from || '(无)'} -> ${diff.baseURL.to}`);
  }
  if (
    !diff.added.length &&
    !diff.removed.length &&
    !diff.changed.length &&
    !diff.baseURL.changed &&
    !ctx.inSyncPatch
  ) {
    parts.push('标记块存在格式/空白差异');
  }
  if (ctx.creds.willAdd) parts.push(`凭据: 补充 refs.${API_KEY_ENV}`);
  return parts.join('；');
}

function statusText(ctx) {
  if (ctx.mode === 'sync') {
    return ctx.wrote.patch || ctx.wrote.credentials || ctx.wrote.excludeFile
      ? '已更新 (updated)'
      : '已同步 (in sync)';
  }
  return ctx.inSyncOverall ? '已同步 (in sync)' : '需要更新 (update needed)';
}

function printHuman(ctx) {
  const out = [];
  out.push('cockpit-tools → DSH 模型同步');
  out.push(`  补丁: ${ctx.target.patchPath}`);
  out.push(`  目录: ${ctx.catalogSource}（${ctx.catalogCount} 个模型）`);
  out.push(
    `  选中: ${ctx.selected.length} 个${
      ctx.selected.length ? ': ' + ctx.selected.map((model) => model.id).join(', ') : ''
    }`,
  );
  if (ctx.excluded.length) {
    out.push(
      `  排除: ${ctx.excluded.length} 个: ${ctx.excluded
        .map((item) => `${item.id} (${excludeReasonLabel(item.reason)})`)
        .join(', ')}`,
    );
  }
  out.push(`  端点: ${ctx.baseUrl}`);
  out.push(`  凭据: ${credentialsLabel(ctx.creds, ctx.wrote)}`);
  out.push(`  状态: ${statusText(ctx)}`);
  out.push(`  变更: ${describeChanges(ctx)}`);

  if (ctx.mode === 'dry-run') {
    out.push('');
    out.push('[dry-run] 标记块将替换为以下内容（未写入任何文件）:');
    out.push(...ctx.newBlockLines);
    out.push('');
    out.push(
      ctx.inSyncOverall
        ? '[dry-run] 已同步 (in sync)，无需改动。'
        : '[dry-run] 需要更新 (update needed)；去掉 --dry-run 即可写入。',
    );
  } else if (ctx.mode === 'check') {
    out.push('');
    out.push(
      ctx.inSyncOverall
        ? '[check] 已同步 (in sync)，退出码 0'
        : '[check] 需要更新 (update needed)，退出码 2',
    );
  } else {
    out.push('');
    if (ctx.wrote.excludeFile) {
      out.push(`[写入] 排除文件已创建: ${ctx.excludeInfo.file}`);
    }
    if (ctx.wrote.patch) {
      const backup = ctx.backups.find((item) => item.target === 'patch');
      out.push(
        `[写入] 补丁已更新: ${ctx.target.patchPath}` +
          (backup ? `（备份: ${backup.path}）` : ''),
      );
    } else {
      out.push('[写入] 补丁无需修改');
    }
    if (ctx.wrote.credentials) {
      const backup = ctx.backups.find((item) => item.target === 'credentials');
      out.push(
        `[写入] 凭据已补充 refs.${API_KEY_ENV}: ${ctx.creds.path}` +
          (backup ? `（备份: ${backup.path}）` : ''),
      );
    } else if (ctx.creds.willAdd) {
      out.push(`[写入] 凭据未写入（--no-credentials 或无法写入）`);
    }
    if (!ctx.wrote.patch && !ctx.wrote.credentials && !ctx.wrote.excludeFile) {
      out.push('[写入] 无需修改，所有目标均已同步。');
    }
  }

  process.stdout.write(out.join('\n') + '\n');
}

function printQuiet(ctx) {
  let line;
  if (ctx.mode === 'sync') {
    line =
      ctx.wrote.patch || ctx.wrote.credentials || ctx.wrote.excludeFile
        ? 'updated'
        : 'in sync';
  } else {
    line = ctx.inSyncOverall ? 'in sync' : `update needed: ${describeChanges(ctx)}`;
  }
  process.stdout.write(line + '\n');
}

function buildJson(ctx) {
  return {
    ok: true,
    command: ctx.mode,
    profile: ctx.opts.profile,
    patch: ctx.target.patchPath,
    credentials: ctx.creds.enabled ? ctx.target.credentialsPath : null,
    cockpitConfig: ctx.endpoint.cockpitConfigPath,
    baseUrl: ctx.baseUrl,
    catalog: { source: ctx.catalogSource, count: ctx.catalogCount },
    models: ctx.selected.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      input: model.input,
      reasoningEfforts: model.reasoningEfforts,
    })),
    excluded: ctx.excluded,
    changes: ctx.diff,
    credentialsAction: ctx.creds.action,
    inSync: ctx.inSyncOverall,
    willWrite: {
      patch: !ctx.inSyncPatch,
      credentials: ctx.creds.willAdd,
      excludeFile: ctx.excludeInfo.pendingCreate,
    },
    wrote: ctx.wrote,
    backups: ctx.backups,
    generatedBlock: ctx.newBlockLines.join('\n'),
    exitCode: ctx.exitCode,
  };
}

function printJson(ctx) {
  process.stdout.write(JSON.stringify(buildJson(ctx), null, 2) + '\n');
}

function reportError(err, opts) {
  const known = err instanceof SyncError;
  const code = known ? err.code : 'EUNEXPECTED';
  const message = (err && err.message) || String(err);
  const hint = known ? err.hint : '';
  if (opts && opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          command: commandName(opts),
          error: { code, message, hint },
        },
        null,
        2,
      ) + '\n',
    );
  }
  process.stderr.write(`[错误] ${message}\n`);
  if (hint) process.stderr.write(`       提示: ${hint}\n`);
  if (!(opts && opts.json)) process.stderr.write('       使用 --help 查看用法。\n');
  return 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(opts) {
  const target = resolveTarget(opts);
  if (!existsSync(target.patchPath)) {
    throw new SyncError(
      'EPATCH',
      `补丁文件不存在: ${target.patchPath}`,
      '请确认 DSH profile 名称（--profile），或用 --patch 指定路径。',
    );
  }

  const patchRaw = readTextFile(target.patchPath, 'EIO', '补丁文件');
  const doc = splitPatch(patchRaw, target.patchPath);
  const oldBlockLines = doc.lines.slice(doc.openIdx + 1, doc.closeIdx);
  const oldBlockText = oldBlockLines.join(doc.eol);

  const cockpit = loadCockpitConfig(opts);
  const endpoint = resolveEndpoint(opts, cockpit, target);
  const catalogInfo = await loadCatalog(opts, endpoint);
  const excludeInfo = loadExcludes(opts);
  const selection = mapCatalog(catalogInfo.data, new Set(excludeInfo.ids));

  if (selection.models.length === 0) {
    throw new SyncError(
      'EMAPPING',
      `没有任何模型通过过滤（目录 ${catalogInfo.count} 个，全部被能力/可见性/排除规则过滤）。`,
      '请检查 cockpit-tools 账号状态、模型能力与 models-exclude.json。',
    );
  }

  const newBlockLines = renderBlock(doc.indent, selection.models, endpoint.baseUrl);
  validateBlock(newBlockLines, doc.indent);
  const newBlockText = newBlockLines.join(doc.eol);

  const newLines = [
    ...doc.lines.slice(0, doc.openIdx + 1),
    ...newBlockLines,
    ...doc.lines.slice(doc.closeIdx),
  ];
  const newText = newLines.join(doc.eol);

  // 写入前再整份校验一次：标记仍唯一、块内容与预期一致。
  const verifyDoc = splitPatch(newText, target.patchPath);
  const verifyBlockText = verifyDoc.lines
    .slice(verifyDoc.openIdx + 1, verifyDoc.closeIdx)
    .join(verifyDoc.eol);
  if (verifyBlockText !== newBlockText) {
    throw new SyncError(
      'EINVALID_RESULT',
      '内部校验失败：生成的补丁标记块与预期不一致，拒绝写入。',
    );
  }

  const inSyncPatch = oldBlockText === newBlockText;
  const diff = diffBlock(oldBlockLines, newBlockLines);
  const creds = planCredentials(opts, target, endpoint.apiKey);
  const inSyncOverall = inSyncPatch && !creds.willAdd;

  const mode = opts.check ? 'check' : opts.dryRun ? 'dry-run' : 'sync';
  const wrote = { patch: false, credentials: false, excludeFile: false };
  const backups = [];
  const stamp = timestampNow();

  if (mode === 'sync') {
    if (excludeInfo.pendingCreate) {
      mkdirSync(path.dirname(excludeInfo.file), { recursive: true });
      writeFileSync(
        excludeInfo.file,
        JSON.stringify(DEFAULT_EXCLUDE_IDS, null, 2) + '\n',
        'utf8',
      );
      wrote.excludeFile = true;
    }
    if (!inSyncPatch) {
      const backup = atomicWriteWithBackup(target.patchPath, newText, stamp);
      if (backup) backups.push({ target: 'patch', path: backup });
      wrote.patch = true;
    }
    if (creds.willAdd) {
      const backup = atomicWriteWithBackup(target.credentialsPath, creds.content, stamp);
      if (backup) backups.push({ target: 'credentials', path: backup });
      wrote.credentials = true;
    }
  }

  const ctx = {
    opts,
    mode,
    target,
    endpoint,
    baseUrl: endpoint.baseUrl,
    catalogSource: catalogInfo.source,
    catalogCount: catalogInfo.count,
    selected: selection.models,
    excluded: selection.excluded,
    excludeInfo,
    creds,
    diff,
    inSyncPatch,
    inSyncOverall,
    newBlockLines,
    newText,
    wrote,
    backups,
    exitCode: 0,
  };
  ctx.exitCode = mode === 'check' && !inSyncOverall ? 2 : 0;

  if (opts.json) printJson(ctx);
  else if (opts.quiet) printQuiet(ctx);
  else printHuman(ctx);

  return ctx.exitCode;
}

async function main() {
  let opts = null;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(HELP + '\n');
      process.exitCode = 0;
      return;
    }
    process.exitCode = await run(opts);
  } catch (err) {
    process.exitCode = reportError(err, opts);
  }
}

main().catch((err) => {
  process.stderr.write(`[错误] ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
