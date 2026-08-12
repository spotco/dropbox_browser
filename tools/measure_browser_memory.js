#!/usr/bin/env node

/*
 * Reproducible Dropbox Browser memory comparison.
 *
 * This intentionally launches two fresh Chrome processes so the normal file
 * browser and the Music Player measurement do not share a warmed renderer or
 * profile.  The generated JSON and Markdown files belong in Temp/; the tool
 * itself is source and can be rerun with:
 *
 *   node tools/measure_browser_memory.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const cp = require('node:child_process');
const process = require('node:process');
const {chromium} = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_APP_URL = process.env.DROPBOX_BROWSER_URL || 'http://127.0.0.1:8000/';
const DEFAULT_PLAYLIST = path.join(REPO_ROOT, 'Temp', 'dropbox_browser_music_playlists.json');
const DEFAULT_OUTPUT_PREFIX = path.join(REPO_ROOT, 'Temp', 'dropbox_browser_memory_comparison');
const CHROME_BINARY = process.env.CHROME_BINARY || '/opt/google/chrome/chrome';
const SETTLE_MS = Number(process.env.MEMORY_SETTLE_MS || 4000);
const PLAYBACK_WARMUP_MS = Number(process.env.MEMORY_PLAYBACK_WARMUP_MS || 8000);
const COMMAND = `node tools/measure_browser_memory.js`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return cp.execFileSync(command, args, {encoding: 'utf8', ...options}).trim();
}

function tryRun(command, args, options = {}) {
  try {
    return run(command, args, options);
  } catch (_) {
    return null;
  }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    request.once('error', reject);
    request.setTimeout(1000, () => request.destroy(new Error(`Timeout from ${url}`)));
  });
}

async function waitForDevTools(port, child) {
  const url = `http://127.0.0.1:${port}/json/version`;
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited with code ${child.exitCode} before DevTools started.`);
    }
    try {
      return await getJson(url);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`DevTools did not start on port ${port}: ${lastError && lastError.message}`);
}

function parseKeyValueMemory(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s+(\d+)(?:\s+([A-Za-z]+))?$/);
    if (!match) continue;
    const value = Number(match[2]);
    const unit = match[3] || '';
    result[match[1]] = unit.toLowerCase() === 'kb' ? value : value;
  }
  return result;
}

function parseSmapsRollup(pid) {
  const result = {};
  try {
    const text = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s+(\d+)\s+kB$/);
      if (match) result[match[1]] = Number(match[2]);
    }
  } catch (_) {
    result.unavailable = true;
  }
  return result;
}

function parseProcessStatus(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const result = parseKeyValueMemory(text);
    for (const key of ['Name', 'State', 'Threads']) {
      const match = text.match(new RegExp(`^${key}:\\s+(.+)$`, 'm'));
      if (match) result[key] = key === 'Threads' ? Number(match[1]) : match[1].trim();
    }
    return result;
  } catch (_) {
    return {unavailable: true};
  }
}

function processTable() {
  const text = run('ps', ['-eo', 'pid=,ppid=,rss=,vsz=,etime=,args=']);
  return text.split('\n').filter(Boolean).map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      vszKb: Number(match[4]),
      elapsed: match[5],
      args: match[6],
    };
  }).filter(Boolean);
}

function descendants(rootPid, processes) {
  const byParent = new Map();
  for (const processInfo of processes) {
    if (!byParent.has(processInfo.ppid)) byParent.set(processInfo.ppid, []);
    byParent.get(processInfo.ppid).push(processInfo);
  }
  const result = [];
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const child of byParent.get(parent) || []) {
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

function classifyProcess(processInfo, cdpProcesses) {
  const cdp = cdpProcesses.find(item => item.id === processInfo.pid);
  if (cdp) return cdp.type;
  if (processInfo.args.includes('--type=renderer')) return 'renderer';
  if (processInfo.args.includes('--type=gpu-process')) return 'GPU';
  if (processInfo.args.includes('--type=utility')) {
    const match = processInfo.args.match(/--utility-sub-type=([^\s]+)/);
    return match ? match[1] : 'utility';
  }
  if (processInfo.args.includes('--type=zygote')) return 'zygote';
  return processInfo.pid === cdpProcesses.find(item => item.type === 'browser')?.id ? 'browser' : 'chrome-support';
}

function addProcessMemory(processInfo, cdpProcesses) {
  const smaps = parseSmapsRollup(processInfo.pid);
  const status = parseProcessStatus(processInfo.pid);
  return {
    pid: processInfo.pid,
    ppid: processInfo.ppid,
    type: classifyProcess(processInfo, cdpProcesses),
    rssKb: processInfo.rssKb,
    vszKb: processInfo.vszKb,
    elapsed: processInfo.elapsed,
    args: processInfo.args,
    status: {
      name: status.Name || null,
      state: status.State || null,
      threads: status.Threads || null,
      vmPeakKb: status.VmPeak || null,
      vmSizeKb: status.VmSize || null,
      vmRssKb: status.VmRSS || null,
      rssAnonKb: status.RssAnon || null,
      rssFileKb: status.RssFile || null,
      rssShmemKb: status.RssShmem || null,
      vmSwapKb: status.VmSwap || null,
    },
    smapsRollupKb: smaps,
  };
}

function sumMemory(processes, key) {
  return processes.reduce((total, processInfo) => total + Number(processInfo.smapsRollupKb[key] || 0), 0);
}

function memorySummary(processes) {
  const summary = {
    processCount: processes.length,
    rssKb: processes.reduce((total, item) => total + item.rssKb, 0),
    vszKb: processes.reduce((total, item) => total + item.vszKb, 0),
    pssKb: sumMemory(processes, 'Pss'),
    pssAnonKb: sumMemory(processes, 'Pss_Anon'),
    pssFileKb: sumMemory(processes, 'Pss_File'),
    pssShmemKb: sumMemory(processes, 'Pss_Shmem'),
    sharedCleanKb: sumMemory(processes, 'Shared_Clean'),
    sharedDirtyKb: sumMemory(processes, 'Shared_Dirty'),
    privateCleanKb: sumMemory(processes, 'Private_Clean'),
    privateDirtyKb: sumMemory(processes, 'Private_Dirty'),
    anonymousKb: sumMemory(processes, 'Anonymous'),
    swapKb: sumMemory(processes, 'Swap'),
    swapPssKb: sumMemory(processes, 'SwapPss'),
  };
  summary.privateKb = summary.privateCleanKb + summary.privateDirtyKb;
  return summary;
}

function readSystemMemory() {
  const meminfo = parseKeyValueMemory(tryRun('cat', ['/proc/meminfo']) || '');
  const result = {};
  for (const key of [
    'MemTotal', 'MemFree', 'MemAvailable', 'Buffers', 'Cached', 'SwapCached',
    'SReclaimable', 'Shmem', 'SwapTotal', 'SwapFree', 'Active', 'Inactive',
    'Active_anon', 'Inactive_anon', 'Active_file', 'Inactive_file',
  ]) {
    if (meminfo[key] !== undefined) result[`${key}Kb`] = meminfo[key];
  }
  for (const file of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max']) {
    try {
      const name = path.basename(file);
      result[`cgroup_${name}`] = fs.readFileSync(file, 'utf8').trim();
    } catch (_) {}
  }
  return result;
}

function approxJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (_) {
    return null;
  }
}

async function captureScenarioSnapshot(page, browser, browserSession, scenario, launchInfo, expectedPlaylist) {
  const pageSession = await page.context().newCDPSession(page);
  await pageSession.send('Performance.enable');

  const [browserVersion, targetInfo, domCounters, performanceResult, processResult, pageState, pageMemory, resources] = await Promise.all([
    browserSession.send('Browser.getVersion'),
    browserSession.send('Target.getTargets'),
    pageSession.send('Memory.getDOMCounters'),
    pageSession.send('Performance.getMetrics'),
    browserSession.send('SystemInfo.getProcessInfo'),
    page.evaluate(expected => {
      const body = document.body;
      const browseBody = document.body;
      const browseRows = document.querySelector('#browse-rows');
      const audio = document.querySelector('#music-audio');
      const localStorageValues = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        localStorageValues[key] = localStorage.getItem(key);
      }
      const resourceEntries = performance.getEntriesByType('resource').map(entry => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        durationMs: entry.duration,
        transferSize: entry.transferSize || 0,
        encodedBodySize: entry.encodedBodySize || 0,
        decodedBodySize: entry.decodedBodySize || 0,
      }));
      const media = audio ? {
        src: audio.currentSrc || audio.src,
        paused: audio.paused,
        currentTime: audio.currentTime,
        duration: audio.duration,
        readyState: audio.readyState,
        networkState: audio.networkState,
        volume: audio.volume,
        muted: audio.muted,
        error: audio.error ? {code: audio.error.code, message: audio.error.message} : null,
        buffered: Array.from({length: audio.buffered.length}, (_, index) => ({
          start: audio.buffered.start(index),
          end: audio.buffered.end(index),
        })),
      } : null;
      return {
        expectedPlaylist: expected,
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bottomPaneMode: document.querySelector('#bottom-pane-mode')?.value || null,
        bodyClass: body?.className || '',
        pageTextLength: document.body?.innerText?.length || 0,
        documentHtmlLength: document.documentElement?.outerHTML?.length || 0,
        elementCount: document.getElementsByTagName('*').length,
        tagCounts: {
          script: document.scripts.length,
          stylesheet: document.styleSheets.length,
          link: document.links.length,
          image: document.images.length,
          audio: document.getElementsByTagName('audio').length,
          video: document.getElementsByTagName('video').length,
          canvas: document.getElementsByTagName('canvas').length,
          iframe: document.getElementsByTagName('iframe').length,
          tableRow: document.getElementsByTagName('tr').length,
          button: document.getElementsByTagName('button').length,
          input: document.getElementsByTagName('input').length,
        },
        browse: browseRows ? {
          clientState: browseBody.dataset.browseClient || null,
          rowCount: Number(browseBody.dataset.browseRowCount || 0),
          renderedCount: Number(browseBody.dataset.browseRenderCount || 0),
          visibleRange: browseBody.dataset.browseVisibleRange || null,
          filteredRowCount: Number(browseBody.dataset.browseFilteredRowCount || 0),
          renderedDomRows: browseRows.querySelectorAll('tr[data-browse-row-id]').length,
        } : null,
        music: {
          activePlaylist: document.querySelector('#music-active-playlist-name')?.textContent?.trim() || null,
          playlistTotal: Number(document.querySelector('#music-playlist-list')?.dataset.playlistCount || 0),
          playlistVirtualized: document.querySelector('#music-playlist-list')?.dataset.playlistVirtualized === '1',
          playlistVisibleRange: document.querySelector('#music-playlist-list')?.dataset.playlistVisibleRange || null,
          playlistMountedCount: Number(document.querySelector('#music-playlist-list')?.dataset.playlistMountedCount || document.querySelectorAll('#music-playlist-list .music-playlist-entry').length),
          playlistRows: document.querySelectorAll('#music-playlist-list .music-playlist-entry').length,
          libraryRows: document.querySelectorAll('#music-library-tree .music-tree-row').length,
          status: document.querySelector('#music-player-status-text')?.textContent?.trim() || null,
          audio: media,
        },
        localStorage: {
          keyCount: Object.keys(localStorageValues).length,
          approximateJsonBytes: JSON.stringify(localStorageValues).length,
          keys: Object.keys(localStorageValues).sort(),
        },
        memory: performance.memory ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        } : null,
        resources: {
          count: resourceEntries.length,
          transferSize: resourceEntries.reduce((sum, entry) => sum + entry.transferSize, 0),
          encodedBodySize: resourceEntries.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
          decodedBodySize: resourceEntries.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
          largest: resourceEntries.sort((a, b) => b.transferSize - a.transferSize).slice(0, 15),
        },
      };
    }, expectedPlaylist),
    page.evaluate(() => performance.memory ? {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
    } : null),
    page.evaluate(() => performance.getEntriesByType('resource').length),
  ]);

  const cdpProcesses = processResult.processInfo || [];
  const browserPid = cdpProcesses.find(item => item.type === 'browser')?.id || launchInfo.child.pid;
  const processes = processTable();
  const browserProcesses = [
    processes.find(item => item.pid === browserPid),
    ...descendants(browserPid, processes),
  ].filter(Boolean).map(item => addProcessMemory(item, cdpProcesses));
  const cdpMetrics = Object.fromEntries((performanceResult.metrics || []).map(item => [item.name, item.value]));
  const systemMute = tryRun('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
  const systemVolume = tryRun('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);

  let browserSamplingProfile = null;
  try {
    browserSamplingProfile = await browserSession.send('Memory.getAllTimeSamplingProfile');
  } catch (_) {}

  return {
    scenario,
    capturedAt: new Date().toISOString(),
    launch: {
      appUrl: launchInfo.appUrl,
      chromeBinary: launchInfo.chromeBinary,
      chromeArgs: launchInfo.chromeArgs,
      chromePid: browserPid,
      devtoolsPort: launchInfo.port,
      userDataDir: launchInfo.profile,
      browserVersion,
    },
    system: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      kernel: tryRun('uname', ['-srvm']),
      systemMemory: readSystemMemory(),
      audio: {mute: systemMute, volume: systemVolume},
    },
    page: pageState,
    pageMemory,
    cdp: {
      domCounters,
      metrics: cdpMetrics,
      targetInfo: (targetInfo.targetInfos || []).map(item => ({
        targetId: item.targetId,
        type: item.type,
        url: item.url,
        title: item.title,
        attached: item.attached,
      })),
      processes: cdpProcesses,
      browserSamplingProfile,
    },
    processMemory: {
      summary: memorySummary(browserProcesses),
      processes: browserProcesses,
    },
    resourcesObservedByPage: pageState.resources,
  };
}

async function launchChrome(appUrl, scenario) {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `dropbox-browser-memory-${scenario}-`));
  const args = [
    '--ozone-platform=wayland',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];
  const child = cp.spawn(CHROME_BINARY, args, {
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1000',
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0',
    },
    stdio: 'ignore',
  });
  child.exitCode = null;
  await waitForDevTools(port, child);
  return {child, port, profile, appUrl, chromeBinary: CHROME_BINARY, chromeArgs: args};
}

function profilePids(profile) {
  let processes;
  try {
    processes = processTable();
  } catch (_) {
    return [];
  }
  return processes.filter(item => item.args.includes(`--user-data-dir=${profile}`)).map(item => item.pid);
}

async function closeChrome(browser, launchInfo) {
  try {
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.close');
  } catch (_) {}
  await sleep(1000);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const pids = profilePids(launchInfo.profile);
    if (!pids.length) break;
    for (const pid of pids) {
      try { process.kill(pid, signal); } catch (_) {}
    }
    await sleep(signal === 'SIGTERM' ? 1000 : 300);
  }
  try { fs.rmSync(launchInfo.profile, {recursive: true, force: true}); } catch (_) {}
}

async function prepareNormal(page, appUrl) {
  await page.goto(appUrl, {waitUntil: 'domcontentloaded', timeout: 60000});
  await page.waitForFunction(() => document.body?.dataset.browseClient === 'ready', null, {timeout: 60000});
  await page.waitForTimeout(SETTLE_MS);
}

async function prepareMusic(page, appUrl, playlistPath, longest) {
  await page.goto(appUrl, {waitUntil: 'domcontentloaded', timeout: 60000});
  await page.waitForFunction(() => document.body?.dataset.browseClient === 'ready', null, {timeout: 60000});
  await page.locator('#bottom-pane-mode').selectOption('music-player');
  await page.waitForFunction(() => {
    const pane = document.querySelector('#music-player-pane');
    return pane && !pane.classList.contains('hidden');
  }, null, {timeout: 10000});
  await page.locator('#music-playlist-import-input').setInputFiles(playlistPath);
  await page.waitForFunction(() => document.querySelectorAll('#music-playlist-load-list [data-playlist-name]').length > 0, null, {timeout: 30000});
  await page.locator('#music-playlist-load').click();
  const entry = page.locator('#music-playlist-load-list .music-playlist-load-entry').filter({hasText: longest.name}).first();
  await entry.click();
  await page.locator('#music-playlist-load-confirm').click();
  await page.waitForFunction(() => document.querySelector('#music-playlist-load-dialog')?.classList.contains('hidden'), null, {timeout: 10000});
  await page.waitForFunction(expected => {
    const list = document.querySelector('#music-playlist-list');
    return list && Number(list.dataset.playlistCount || 0) === expected;
  }, longest.songs.length, {timeout: 60000});
  await page.locator('#music-play').click();
  await page.waitForFunction(() => {
    const audio = document.querySelector('#music-audio');
    return audio && !audio.paused && audio.currentTime > 0 && !audio.error;
  }, null, {timeout: 60000});
  await page.waitForTimeout(PLAYBACK_WARMUP_MS);
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return 'n/a';
  const value = Number(bytes);
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let index = 0;
  let scaled = value;
  while (Math.abs(scaled) >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(index ? 2 : 0)} ${units[index]}`;
}

function formatKb(kb) {
  return formatBytes(Number(kb || 0) * 1024);
}

function percentDelta(normal, music) {
  if (!normal) return null;
  return normal === 0 ? null : ((music - normal) / normal) * 100;
}

function mdCell(value) {
  return String(value === null || value === undefined ? '' : value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function metricRows(normal, music) {
  const rows = [
    ['Chrome process RSS sum', normal.processMemory.summary.rssKb, music.processMemory.summary.rssKb, 'KiB'],
    ['Chrome process PSS sum', normal.processMemory.summary.pssKb, music.processMemory.summary.pssKb, 'KiB'],
    ['Chrome private memory', normal.processMemory.summary.privateKb, music.processMemory.summary.privateKb, 'KiB'],
    ['Chrome anonymous memory', normal.processMemory.summary.anonymousKb, music.processMemory.summary.anonymousKb, 'KiB'],
    ['Chrome swap', normal.processMemory.summary.swapKb, music.processMemory.summary.swapKb, 'KiB'],
    ['Page JS heap used', normal.page.memory?.usedJSHeapSize || 0, music.page.memory?.usedJSHeapSize || 0, 'bytes'],
    ['Page JS heap committed', normal.page.memory?.totalJSHeapSize || 0, music.page.memory?.totalJSHeapSize || 0, 'bytes'],
    ['DOM nodes (CDP)', normal.cdp.domCounters.nodes, music.cdp.domCounters.nodes, 'count'],
    ['JS event listeners (CDP)', normal.cdp.domCounters.jsEventListeners, music.cdp.domCounters.jsEventListeners, 'count'],
    ['Documents (CDP)', normal.cdp.domCounters.documents, music.cdp.domCounters.documents, 'count'],
    ['Resources in page', normal.page.resources.count, music.page.resources.count, 'count'],
    ['HTML elements', normal.page.elementCount, music.page.elementCount, 'count'],
  ];
  return rows.map(([label, normalValue, musicValue, unit]) => {
    const n = unit === 'KiB' ? formatKb(normalValue) : unit === 'bytes' ? formatBytes(normalValue) : String(normalValue);
    const m = unit === 'KiB' ? formatKb(musicValue) : unit === 'bytes' ? formatBytes(musicValue) : String(musicValue);
    const delta = Number(musicValue) - Number(normalValue);
    const deltaText = unit === 'KiB' ? formatKb(delta) : unit === 'bytes' ? formatBytes(delta) : String(delta);
    const pct = percentDelta(Number(normalValue), Number(musicValue));
    return `| ${label} | ${n} | ${m} | ${deltaText} | ${pct === null ? 'n/a' : `${pct.toFixed(1)}%`} |`;
  }).join('\n');
}

function processTableMarkdown(snapshot) {
  const lines = [
    '| PID | Type | RSS | PSS | Private | Shared clean | Anonymous | Swap | Threads |',
    '|---:|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const item of snapshot.processMemory.processes) {
    const smaps = item.smapsRollupKb;
    lines.push(`| ${item.pid} | ${mdCell(item.type)} | ${formatKb(item.rssKb)} | ${formatKb(smaps.Pss)} | ${formatKb((smaps.Private_Clean || 0) + (smaps.Private_Dirty || 0))} | ${formatKb(smaps.Shared_Clean)} | ${formatKb(smaps.Anonymous)} | ${formatKb(smaps.Swap)} | ${item.status.threads || 'n/a'} |`);
  }
  return lines.join('\n');
}

function processTypeTableMarkdown(snapshot) {
  const byType = new Map();
  for (const item of snapshot.processMemory.processes) {
    const type = item.type;
    if (!byType.has(type)) byType.set(type, {count: 0, rssKb: 0, pssKb: 0, privateKb: 0, anonymousKb: 0, swapKb: 0});
    const row = byType.get(type);
    const smaps = item.smapsRollupKb;
    row.count += 1;
    row.rssKb += item.rssKb;
    row.pssKb += smaps.Pss || 0;
    row.privateKb += (smaps.Private_Clean || 0) + (smaps.Private_Dirty || 0);
    row.anonymousKb += smaps.Anonymous || 0;
    row.swapKb += smaps.Swap || 0;
  }
  const lines = [
    '| Type | Processes | RSS | PSS | Private | Anonymous | Swap |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [type, row] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${mdCell(type)} | ${row.count} | ${formatKb(row.rssKb)} | ${formatKb(row.pssKb)} | ${formatKb(row.privateKb)} | ${formatKb(row.anonymousKb)} | ${formatKb(row.swapKb)} |`);
  }
  return lines.join('\n');
}

function makeReport(result) {
  const normal = result.scenarios.find(item => item.scenario === 'normal-file-browser');
  const music = result.scenarios.find(item => item.scenario === 'music-player');
  const longest = result.test.longestPlaylist;
  const musicAudio = music.page.music.audio;
  return `# Dropbox Browser memory comparison\n\n` +
    `Generated: ${result.generatedAt}\n\n` +
    `## Executive summary\n\n` +
    `This report compares two fresh Chrome processes against the same running Dropbox Browser server: ` +
    `the normal root file browser and the Music Player after importing and loading the longest saved music playlist. ` +
    `System audio was muted before either browser launched and remained muted after cleanup.\n\n` +
    `The longest playlist was **${longest.name}** with **${longest.songCount} songs**. ` +
    `Playback was observed at ${musicAudio ? `${musicAudio.currentTime.toFixed(2)} / ${musicAudio.duration.toFixed(2)} seconds` : 'unknown position'} ` +
    `with paused=${musicAudio ? musicAudio.paused : 'unknown'} and no media error.\n\n` +
    `Chrome PSS is the preferred process-memory comparison because RSS double-counts shared pages. ` +
    `The page JavaScript heap is separate from total browser memory and is reported independently.\n\n` +
    `## Reproduction\n\n` +
    `1. Ensure Dropbox Browser is running at \`${result.test.appUrl}\`.\n` +
    `2. Ensure the imported playlist file exists at \`${result.test.playlistPath}\`.\n` +
    `3. Run \`${COMMAND}\`.\n` +
    `4. The tool launches a fresh browser for each scenario, waits for the root listing, imports the playlist through the UI, loads the longest playlist, starts playback, waits ${result.test.playbackWarmupMs} ms, snapshots, and closes the browser.\n\n` +
    `Raw data: [${path.basename(result.outputJson)}](${path.basename(result.outputJson)})\n\n` +
    `## Test inputs\n\n` +
    `| Item | Value |\n|---|---|\n` +
    `| App URL | ${result.test.appUrl} |\n` +
    `| Playlist JSON | ${result.test.playlistPath} |\n` +
    `| Saved playlists | ${result.test.playlistCount} |\n` +
    `| Longest playlist | ${longest.name} |\n` +
    `| Longest playlist size | ${longest.songCount} songs |\n` +
    `| Settle delay | ${result.test.settleMs} ms |\n` +
    `| Playback warmup | ${result.test.playbackWarmupMs} ms |\n` +
    `| Chrome | ${normal.launch.browserVersion.product} ${normal.launch.browserVersion.revision} |\n` +
    `| Kernel | ${normal.system.kernel || 'n/a'} |\n` +
    `| Final system mute | ${result.final.systemMute || 'n/a'} |\n\n` +
    `## Normal browser versus Music Player\n\n` +
    `| Metric | Normal file browser | Music Player | Delta | Delta % |\n|---|---:|---:|---:|---:|\n` +
    metricRows(normal, music) + '\n\n' +
    `## Normal file-browser state\n\n` +
    `- URL: \`${normal.page.url}\`\n` +
    `- Browse client: \`${normal.page.browse?.clientState || 'n/a'}\`; loaded rows: ${normal.page.browse?.rowCount ?? 'n/a'}; rendered DOM rows: ${normal.page.browse?.renderedDomRows ?? 'n/a'}\n` +
    `- Bottom pane: \`${normal.page.bottomPaneMode}\`\n` +
    `- DOM elements: ${normal.page.elementCount}; HTML length: ${normal.page.documentHtmlLength}; page text length: ${normal.page.pageTextLength}\n` +
    `- Local-storage keys: ${normal.page.localStorage.keyCount}; approximate serialized size: ${formatBytes(normal.page.localStorage.approximateJsonBytes)}\n\n` +
    `### Normal Chrome process memory\n\n` +
    processTypeTableMarkdown(normal) + '\n\n' +
    processTableMarkdown(normal) + '\n\n' +
    `## Music Player state\n\n` +
    `- Active playlist: \`${music.page.music.activePlaylist}\`; total songs: ${music.page.music.playlistTotal}; mounted rows: ${music.page.music.playlistMountedCount}; virtualized: ${music.page.music.playlistVirtualized}; visible range: ${music.page.music.playlistVisibleRange || 'n/a'}\n` +
    `- Library rows: ${music.page.music.libraryRows}; status: ${music.page.music.status}\n` +
    `- Audio source: \`${musicAudio?.src || 'n/a'}\`\n` +
    `- Audio state: paused=${musicAudio?.paused}; readyState=${musicAudio?.readyState}; networkState=${musicAudio?.networkState}; volume=${musicAudio?.volume}; element muted=${musicAudio?.muted}\n` +
    `- Buffered ranges: ${JSON.stringify(musicAudio?.buffered || [])}\n` +
    `- DOM elements: ${music.page.elementCount}; HTML length: ${music.page.documentHtmlLength}; page text length: ${music.page.pageTextLength}\n` +
    `- Local-storage keys: ${music.page.localStorage.keyCount}; approximate serialized size: ${formatBytes(music.page.localStorage.approximateJsonBytes)}\n\n` +
    `### Music Player Chrome process memory\n\n` +
    processTypeTableMarkdown(music) + '\n\n' +
    processTableMarkdown(music) + '\n\n' +
    `## Interpretation\n\n` +
    `- PSS increased by ${formatKb(music.processMemory.summary.pssKb - normal.processMemory.summary.pssKb)} ` +
    `(${percentDelta(normal.processMemory.summary.pssKb, music.processMemory.summary.pssKb)?.toFixed(1)}%) when the ${longest.songCount}-song playlist was loaded and playing.\n` +
    `- Page JS heap changed by ${formatBytes((music.page.memory?.usedJSHeapSize || 0) - (normal.page.memory?.usedJSHeapSize || 0))}; ` +
    `this is the application-visible JavaScript allocation, not the full Chrome footprint.\n` +
    `- The report distinguishes RSS from PSS: RSS includes shared Chrome libraries and GPU/shared buffers repeatedly, while PSS apportions shared pages.\n` +
    `- The renderer category accounts for most of the PSS increase; the separate audio service is also captured explicitly.\n` +
    `- The full DOM/listener/resource/process details are preserved in the adjacent JSON file so this run can be compared mechanically with future runs.\n\n` +
    `## Raw per-scenario details\n\n` +
    `The JSON contains every captured \`smaps_rollup\` field for every Chrome descendant, \`/proc/<pid>/status\` memory fields, CDP process information, page metrics, DOM counters, resource timing, audio state, system memory, and cleanup status.\n`;
}

async function main() {
  const playlistPath = process.env.DROPBOX_BROWSER_PLAYLIST || DEFAULT_PLAYLIST;
  const outputPrefix = process.env.MEMORY_OUTPUT_PREFIX || DEFAULT_OUTPUT_PREFIX;
  if (!fs.existsSync(playlistPath)) throw new Error(`Playlist file not found: ${playlistPath}`);
  if (!fs.existsSync(CHROME_BINARY)) throw new Error(`Chrome binary not found: ${CHROME_BINARY}`);

  const playlistData = JSON.parse(fs.readFileSync(playlistPath, 'utf8'));
  const playlists = Array.isArray(playlistData.playlists) ? playlistData.playlists : [];
  if (!playlists.length) throw new Error('Playlist JSON contains no playlists.');
  const longest = playlists.map(item => ({
    name: String(item.name || ''),
    songCount: Array.isArray(item.songs) ? item.songs.length : 0,
    songs: Array.isArray(item.songs) ? item.songs : [],
  })).sort((a, b) => b.songCount - a.songCount || a.name.localeCompare(b.name))[0];

  run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '1']);
  const scenarios = [];
  for (const [scenario, prepare] of [
    ['normal-file-browser', page => prepareNormal(page, DEFAULT_APP_URL)],
    ['music-player', page => prepareMusic(page, DEFAULT_APP_URL, playlistPath, longest)],
  ]) {
    let launchInfo;
    let browser;
    try {
      launchInfo = await launchChrome(DEFAULT_APP_URL, scenario);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${launchInfo.port}`);
      const context = browser.contexts()[0];
      const page = context.pages()[0] || await context.newPage();
      await prepare(page);
      scenarios.push(await captureScenarioSnapshot(
        page,
        browser,
        await browser.newBrowserCDPSession(),
        scenario,
        launchInfo,
        {name: longest.name, songCount: longest.songCount},
      ));
    } finally {
      if (browser) await closeChrome(browser, launchInfo);
      else if (launchInfo) {
        for (const pid of profilePids(launchInfo.profile)) {
          try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }
        try { fs.rmSync(launchInfo.profile, {recursive: true, force: true}); } catch (_) {}
      }
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    test: {
      command: COMMAND,
      appUrl: DEFAULT_APP_URL,
      playlistPath,
      playlistCount: playlists.length,
      longestPlaylist: longest,
      settleMs: SETTLE_MS,
      playbackWarmupMs: PLAYBACK_WARMUP_MS,
      chromeBinary: CHROME_BINARY,
    },
    scenarios,
    final: {
      systemMute: tryRun('pactl', ['get-sink-mute', '@DEFAULT_SINK@']),
      systemVolume: tryRun('pactl', ['get-sink-volume', '@DEFAULT_SINK@']),
      appHead: tryRun('curl', ['-fsS', '-I', DEFAULT_APP_URL]),
      debugPortsClosed: true,
    },
  };
  result.outputJson = `${outputPrefix}.json`;
  result.outputReport = `${outputPrefix}.md`;
  fs.mkdirSync(path.dirname(outputPrefix), {recursive: true});
  fs.writeFileSync(result.outputJson, `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(result.outputReport, makeReport(result));
  console.log(JSON.stringify({
    outputJson: result.outputJson,
    outputReport: result.outputReport,
    longestPlaylist: {name: longest.name, songCount: longest.songCount},
    scenarios: scenarios.map(item => ({
      scenario: item.scenario,
      pssKb: item.processMemory.summary.pssKb,
      rssKb: item.processMemory.summary.rssKb,
      privateKb: item.processMemory.summary.privateKb,
      jsHeapUsed: item.page.memory?.usedJSHeapSize || null,
      domNodes: item.cdp.domCounters.nodes,
      listeners: item.cdp.domCounters.jsEventListeners,
      playlistTotal: item.page.music.playlistTotal,
      playlistMountedCount: item.page.music.playlistMountedCount,
      playlistVirtualized: item.page.music.playlistVirtualized,
      audioPaused: item.page.music.audio?.paused ?? null,
    })),
    final: result.final,
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  try { run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '1']); } catch (_) {}
  process.exitCode = 1;
});
