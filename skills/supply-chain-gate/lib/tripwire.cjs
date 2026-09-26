'use strict';
/*
 * tripwire.cjs — loaded into EVERY node process in a room via NODE_OPTIONS=--require <this>.
 * Watches fs reads (of decoy files), env reads (of decoy keys), network (allowlist + decoy-in-payload),
 * and child_process (argv scan + env re-injection). Appends one JSON line per event to TRIPWIRE_LOG.
 *
 * Cardinal rules (SPEC §6):
 *   1. NEVER throw from a hook. Every hook body is wrapped in try/catch that swallows.
 *   2. Log with the ORIGINAL, unwrapped fs.appendFileSync, captured before we patch anything,
 *      so logging can never re-enter our own fs hooks (infinite recursion).
 *   3. Attribution: first stack frame inside /node_modules/<pkg>/ that is not inside npm itself;
 *      else npm_package_name + npm_lifecycle_event; else "project".
 *   4. In enforce mode, block disallowed network (destroy socket / reject) and log it as attempted.
 *
 * This file is CommonJS and uses ONLY Node built-ins (must run on Node 18+). No throwing at top level.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- Captured originals (before any patching) -------------------------------
const rawAppendFileSync = fs.appendFileSync.bind(fs);

// ---- Config from environment ------------------------------------------------
const LOG = process.env.TRIPWIRE_LOG || '';
const MODE = process.env.TRIPWIRE_MODE === 'enforce' ? 'enforce' : 'monitor';
const ALLOW = new Set(
  (process.env.TRIPWIRE_ALLOW || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
// localhost is always allowed (npm's own metadata, TrueForge code-mode client, etc.)
for (const h of ['localhost', '127.0.0.1', '::1', '0.0.0.0']) ALLOW.add(h);

// Room HOME: decoy files live under here. Reads of files under it are honeytoken reads.
const ROOM_HOME = process.env.HOME || os.homedir() || '';
const ROOM_HOME_RESOLVED = ROOM_HOME ? safeResolve(ROOM_HOME) : '';

// Decoy string values to scan for in outbound data / argv. Collected from the env vars the
// room sets (NPM_TOKEN=npm_DECOY_<room>, etc). Any value containing "DECOY" is a tripwire canary.
const DECOY_VALUES = collectDecoyValues();

// ---- Tiny helpers -----------------------------------------------------------
function safeResolve(p) {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    try {
      return path.resolve(p);
    } catch {
      return String(p || '');
    }
  }
}

function collectDecoyValues() {
  const out = [];
  try {
    // Read raw values straight off the real process.env object BEFORE we wrap it in a Proxy,
    // so collecting our own canaries does not log a HONEYTOKEN_READ.
    for (const k of Object.keys(process.env)) {
      const v = process.env[k];
      if (typeof v === 'string' && v.length >= 6 && v.includes('DECOY')) out.push(v);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function containsDecoy(s) {
  if (!s) return null;
  let hay;
  try {
    hay = typeof s === 'string' ? s : String(s);
  } catch {
    return null;
  }
  for (const d of DECOY_VALUES) {
    if (d && hay.indexOf(d) !== -1) return d;
  }
  return null;
}

function underRoomHome(resolvedPath) {
  if (!ROOM_HOME_RESOLVED || !resolvedPath) return false;
  const base = ROOM_HOME_RESOLVED.endsWith(path.sep)
    ? ROOM_HOME_RESOLVED
    : ROOM_HOME_RESOLVED + path.sep;
  return resolvedPath === ROOM_HOME_RESOLVED || resolvedPath.startsWith(base);
}

// ---- Attribution ------------------------------------------------------------
// Returns {pkg, lifecycle, frame}. pkg="npm" for stack frames inside npm's own install dir.
function attribute() {
  const info = { pkg: null, lifecycle: null, frame: null };
  try {
    const err = {};
    const orig = Error.prepareStackTrace;
    Error.prepareStackTrace = (_e, frames) => frames;
    Error.captureStackTrace(err, attribute);
    const frames = err.stack || [];
    Error.prepareStackTrace = orig;

    for (const f of frames) {
      let file;
      try {
        file = f.getFileName && f.getFileName();
      } catch {
        file = null;
      }
      if (!file) continue;
      const norm = file.replace(/\\/g, '/');
      const idx = norm.indexOf('/node_modules/');
      if (idx === -1) continue;
      const rest = norm.slice(idx + '/node_modules/'.length);
      // package name: @scope/name or name (first one or two path segments)
      const parts = rest.split('/');
      let pkg;
      if (parts[0] && parts[0].startsWith('@') && parts[1]) pkg = parts[0] + '/' + parts[1];
      else pkg = parts[0];
      if (!pkg) continue;
      // npm's own code (the CLI itself) is actor "npm", not the package under test.
      if (pkg === 'npm' || rest.startsWith('npm/')) {
        info.pkg = 'npm';
        info.frame = shortFrame(norm, f);
        // keep scanning: a deeper frame may belong to the real package
        continue;
      }
      info.pkg = pkg;
      info.frame = shortFrame(norm, f);
      return info; // first non-npm package frame wins
    }
  } catch {
    /* fall through to env-based attribution */
  }

  // No useful stack frame. Fall back to npm's lifecycle env vars.
  try {
    const name = process.env.npm_package_name;
    const life = process.env.npm_lifecycle_event;
    if (name) {
      info.pkg = info.pkg && info.pkg !== 'npm' ? info.pkg : name;
      info.lifecycle = life || null;
      return info;
    }
  } catch {
    /* ignore */
  }
  if (!info.pkg) info.pkg = 'project';
  return info;
}

function shortFrame(normFile, f) {
  try {
    const idx = normFile.indexOf('/node_modules/');
    const rel = idx === -1 ? normFile : normFile.slice(idx + 1);
    let line = null;
    try {
      line = f.getLineNumber && f.getLineNumber();
    } catch {
      line = null;
    }
    return line ? `${rel}:${line}` : rel;
  } catch {
    return null;
  }
}

// ---- Logging ----------------------------------------------------------------
function log(type, detail, decoyHit) {
  if (!LOG) return;
  try {
    const actor = attribute();
    const evt = {
      t: Date.now(),
      pid: process.pid,
      type,
      detail: truncate(detail, 300),
      actor: { pkg: actor.pkg, lifecycle: actor.lifecycle, frame: actor.frame },
      decoy_hit: decoyHit || null,
    };
    rawAppendFileSync(LOG, JSON.stringify(evt) + '\n');
  } catch {
    /* never throw from logging */
  }
}

function truncate(s, n) {
  try {
    const str = typeof s === 'string' ? s : String(s);
    return str.length > n ? str.slice(0, n) + '…' : str;
  } catch {
    return '';
  }
}

// ---- fs read hooks (honeytoken reads under room HOME) -----------------------
function pathFromFd(fd) {
  // best-effort; only used for logging detail
  try {
    if (process.platform === 'linux') return fs.readlinkSync('/proc/self/fd/' + fd);
  } catch {
    /* ignore */
  }
  return null;
}

function maybeLogRead(arg, api) {
  try {
    if (typeof arg !== 'string' && !Buffer.isBuffer(arg) && !(arg instanceof URL)) return;
    let p;
    if (arg instanceof URL) p = arg.pathname;
    else p = Buffer.isBuffer(arg) ? arg.toString('utf8') : String(arg);
    const resolved = safeResolve(p);
    if (underRoomHome(resolved)) {
      log('fs_read', `${api} ${resolved}`, null);
    }
  } catch {
    /* ignore */
  }
}

function wrapReadSync(name) {
  const orig = fs[name];
  if (typeof orig !== 'function') return;
  fs[name] = function (p, ...rest) {
    maybeLogRead(p, name);
    return orig.apply(this, arguments);
  };
}

function wrapReadCb(name) {
  const orig = fs[name];
  if (typeof orig !== 'function') return;
  fs[name] = function (p, ...rest) {
    maybeLogRead(p, name);
    return orig.apply(this, arguments);
  };
}

// ---- fs write hooks (attribution only; writes are allowed to happen) --------
function maybeLogWrite(arg, api) {
  try {
    let p;
    if (arg instanceof URL) p = arg.pathname;
    else if (typeof arg === 'string') p = arg;
    else if (Buffer.isBuffer(arg)) p = arg.toString('utf8');
    else return;
    const resolved = safeResolve(p);
    // don't log our own append to the event log
    if (LOG && resolved === safeResolve(LOG)) return;
    log('fs_write', `${api} ${resolved}`, null);
  } catch {
    /* ignore */
  }
}

function wrapWrite(name) {
  const orig = fs[name];
  if (typeof orig !== 'function') return;
  fs[name] = function (p, ...rest) {
    maybeLogWrite(p, name);
    return orig.apply(this, arguments);
  };
}

function installFsHooks() {
  try {
    for (const n of ['readFileSync', 'openSync', 'createReadStream']) wrapReadSync(n);
    for (const n of ['readFile', 'open']) wrapReadCb(n);
    // promises.readFile / promises.open
    if (fs.promises) {
      for (const n of ['readFile', 'open']) {
        const orig = fs.promises[n];
        if (typeof orig === 'function') {
          fs.promises[n] = function (p, ...rest) {
            maybeLogRead(p, 'promises.' + n);
            return orig.apply(this, arguments);
          };
        }
      }
    }
    for (const n of [
      'writeFile',
      'writeFileSync',
      'appendFile',
      'mkdir',
      'mkdirSync',
      'rename',
      'renameSync',
      'unlink',
      'unlinkSync',
      'rm',
      'rmSync',
      'copyFile',
      'copyFileSync',
      'createWriteStream',
    ]) {
      wrapWrite(n);
    }
    // NOTE: fs.appendFileSync is intentionally NOT wrapped for the raw handle we captured,
    // but the public fs.appendFileSync IS wrapped for attribution of package writes.
    wrapWrite('appendFileSync');
    if (fs.promises) {
      for (const n of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'copyFile']) {
        const orig = fs.promises[n];
        if (typeof orig === 'function') {
          fs.promises[n] = function (p, ...rest) {
            maybeLogWrite(p, 'promises.' + n);
            return orig.apply(this, arguments);
          };
        }
      }
    }
  } catch {
    /* ignore */
  }
}

// True when THIS process is the npm CLI itself (not a lifecycle-script child).
// npm's config layer is hostile to a process.env Proxy (it silently exits 1), but the
// package's own postinstall runs in a separate plain node process that tolerates it fine —
// and that child is where honeytoken env reads actually happen. So we install the env Proxy
// everywhere EXCEPT the npm CLI process.
function isNpmCliProcess() {
  try {
    const a1 = (process.argv[1] || '').replace(/\\/g, '/');
    // Match both the sandbox shape (.../bin/npm-cli.js — confirmed in TrueForge's image, SPEC §10)
    // and host wrapper shapes (/usr/local/bin/npm, .../npm, npx). We are the npm CLI when argv[1]'s
    // basename is npm/npx (with or without a .js/-cli suffix) or the path is inside an npm install.
    const base = a1.split('/').pop() || '';
    if (/^(npm|npx)$/.test(base)) return true;
    if (/^(npm-cli|npx-cli)\.js$/.test(base)) return true;
    if (/\/node_modules\/npm\//.test(a1)) return true;
    if (process.env.npm_execpath && /(npm-cli\.js|\/npm)$/.test(process.env.npm_execpath) && !process.env.npm_lifecycle_event) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

// ---- env Proxy (honeytoken env reads) ---------------------------------------
function installEnvProxy() {
  if (isNpmCliProcess()) return; // see isNpmCliProcess: the Proxy breaks npm's own config layer
  try {
    const real = process.env;
    const isDecoyKey = (k) => {
      try {
        const v = real[k];
        return typeof v === 'string' && v.includes('DECOY');
      } catch {
        return false;
      }
    };
    // Minimal, invariant-safe Proxy: only a `get` trap (logs decoy reads) plus a
    // `getOwnPropertyDescriptor` trap that forces configurable:true. process.env reports its
    // keys as non-configurable; when code does {...process.env}, the spread calls
    // getOwnPropertyDescriptor per key, and a non-configurable descriptor on a Proxy trips the
    // invariant and throws OUTSIDE our try/catch (this silently killed npm). Forcing
    // configurable:true keeps every Proxy invariant satisfied. No `ownKeys` trap: enumeration is
    // not a rule, and trapping it is the other invariant hazard. Decoy env reads that matter are
    // also caught downstream by DECOY_EXFIL when the value leaves the room.
    const proxy = new Proxy(real, {
      get(target, prop, recv) {
        try {
          if (typeof prop === 'string' && isDecoyKey(prop)) {
            log('env_read', `read env ${prop}`, real[prop]);
          }
        } catch {
          /* ignore */
        }
        return Reflect.get(target, prop, recv);
      },
      getOwnPropertyDescriptor(target, prop) {
        const d = Reflect.getOwnPropertyDescriptor(target, prop);
        if (d) d.configurable = true;
        return d;
      },
    });
    // Node rejects getter descriptors on process.env but allows reassigning the property itself.
    Object.defineProperty(process, 'env', {
      value: proxy,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // If the Proxy is rejected, we rely on DECOY_EXFIL (payload scan), which needs no env hook.
  }
}

// ---- network hooks ----------------------------------------------------------
function hostAllowed(host) {
  if (!host) return true; // can't tell; don't block
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (ALLOW.has(h)) return true;
  // allow subdomains of allowlisted hosts (e.g. foo.github.com when github.com is allowed)
  for (const a of ALLOW) {
    if (h === a || h.endsWith('.' + a)) return true;
  }
  return false;
}

function scanBodyForDecoy(chunk) {
  try {
    if (chunk == null) return null;
    const s = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : null;
    if (s == null) return null;
    return containsDecoy(s);
  } catch {
    return null;
  }
}

function installNetHooks() {
  const net = require('net');
  const dns = require('dns');

  // net.Socket.prototype.connect covers raw TCP and (via its internals) TLS sockets.
  try {
    const origConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (options, ...rest) {
      try {
        // net.connect() normalizes args to a single array [options, cb]; unwrap that first.
        let a0 = options;
        if (Array.isArray(a0)) a0 = a0[0];
        let host = null;
        let port = null;
        if (a0 && typeof a0 === 'object') {
          host = a0.host || a0.hostname || null;
          port = a0.port || null;
        } else if (typeof rest[0] === 'string' || (Array.isArray(options) && typeof options[1] === 'string')) {
          // connect(port, host, cb)
          host = Array.isArray(options) ? options[1] : rest[0];
          port = a0;
        } else {
          port = a0;
        }
        if (host && !hostAllowed(host)) {
          log('net_connect', `connect ${host}:${port || ''} (blocked)`, null);
          if (MODE === 'enforce') {
            try {
              this.destroy(new Error('blocked by tripwire: ' + host));
            } catch {
              /* ignore */
            }
            return this;
          }
        } else if (host) {
          log('net_connect', `connect ${host}:${port || ''}`, null);
        }
      } catch {
        /* ignore */
      }
      return origConnect.apply(this, arguments);
    };
  } catch {
    /* ignore */
  }

  // dns.lookup / dns.promises.lookup — a disallowed name resolution is itself suspicious.
  try {
    const origLookup = dns.lookup;
    dns.lookup = function (hostname, ...rest) {
      try {
        if (hostname && !hostAllowed(hostname)) {
          log('dns_lookup', `lookup ${hostname} (blocked)`, containsDecoy(hostname));
          if (MODE === 'enforce') {
            const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
            if (cb) {
              process.nextTick(() => cb(new Error('blocked by tripwire: ' + hostname)));
              return;
            }
          }
        }
      } catch {
        /* ignore */
      }
      return origLookup.apply(this, arguments);
    };
    if (dns.promises && dns.promises.lookup) {
      const origP = dns.promises.lookup;
      dns.promises.lookup = function (hostname, ...rest) {
        try {
          if (hostname && !hostAllowed(hostname)) {
            log('dns_lookup', `lookup ${hostname} (blocked)`, containsDecoy(hostname));
            if (MODE === 'enforce') return Promise.reject(new Error('blocked by tripwire: ' + hostname));
          }
        } catch {
          /* ignore */
        }
        return origP.apply(this, arguments);
      };
    }
  } catch {
    /* ignore */
  }

  // http(s).request / .get — wrap write/end to scan bodies for decoys.
  for (const mod of ['http', 'https']) {
    try {
      const m = require(mod);
      for (const fn of ['request', 'get']) {
        const orig = m[fn];
        if (typeof orig !== 'function') continue;
        m[fn] = function (...args) {
          let host = null;
          try {
            const a0 = args[0];
            if (typeof a0 === 'string') host = new URL(a0).hostname;
            else if (a0 instanceof URL) host = a0.hostname;
            else if (a0 && typeof a0 === 'object') host = a0.host || a0.hostname || null;
            if (host) host = String(host).split(':')[0];
          } catch {
            /* ignore */
          }
          const blocked = host && !hostAllowed(host);
          if (blocked) log('http_request', `${mod}.${fn} ${host} (blocked)`, null);
          const req = orig.apply(this, args);
          try {
            const wrapChunkFn = (name) => {
              const of = req[name];
              if (typeof of !== 'function') return;
              req[name] = function (chunk, ...r) {
                const hit = scanBodyForDecoy(chunk);
                if (hit) log('exfil_body', `${mod} body carried decoy to ${host || '?'}`, hit);
                return of.apply(this, arguments);
              };
            };
            wrapChunkFn('write');
            wrapChunkFn('end');
            if (blocked && MODE === 'enforce') {
              try {
                req.destroy(new Error('blocked by tripwire: ' + host));
              } catch {
                /* ignore */
              }
            }
          } catch {
            /* ignore */
          }
          return req;
        };
      }
    } catch {
      /* ignore */
    }
  }

  // globalThis.fetch — scan URL + body, block disallowed host in enforce mode.
  try {
    const origFetch = globalThis.fetch;
    if (typeof origFetch === 'function') {
      globalThis.fetch = function (input, init) {
        try {
          let url = null;
          if (typeof input === 'string') url = input;
          else if (input instanceof URL) url = input.href;
          else if (input && typeof input === 'object' && input.url) url = input.url;
          let host = null;
          try {
            host = url ? new URL(url).hostname : null;
          } catch {
            /* ignore */
          }
          const urlHit = containsDecoy(url);
          const bodyHit = init && init.body ? scanBodyForDecoy(init.body) : null;
          const hit = urlHit || bodyHit;
          if (host && !hostAllowed(host)) {
            log('fetch', `fetch ${host} (blocked)`, hit);
            if (MODE === 'enforce') return Promise.reject(new Error('blocked by tripwire: ' + host));
          } else if (hit) {
            log('exfil_body', `fetch to ${host || '?'} carried decoy`, hit);
          }
        } catch {
          /* ignore */
        }
        return origFetch.apply(this, arguments);
      };
    }
  } catch {
    /* ignore */
  }
}

// ---- child_process hooks ----------------------------------------------------
// Re-inject NODE_OPTIONS/PATH into custom envs so children stay watched, and scan argv for decoys.
function fixChildEnv(opts) {
  try {
    if (!opts || typeof opts !== 'object' || !opts.env) return opts;
    const env = opts.env;
    // Only touch it if the caller replaced env (otherwise child inherits ours already).
    if (process.env.NODE_OPTIONS && !env.NODE_OPTIONS) env.NODE_OPTIONS = process.env.NODE_OPTIONS;
    if (process.env.NODE_OPTIONS && env.NODE_OPTIONS && env.NODE_OPTIONS.indexOf('tripwire') === -1) {
      env.NODE_OPTIONS = env.NODE_OPTIONS + ' ' + process.env.NODE_OPTIONS;
    }
    // keep our shim dir at the front of PATH
    if (process.env.PATH) {
      const shimDir = (process.env.PATH.split(path.delimiter)[0]) || '';
      const cur = env.PATH || env.Path || '';
      if (shimDir && cur.indexOf(shimDir) === -1) {
        env.PATH = shimDir + path.delimiter + cur;
      }
    }
    // propagate log + mode + allow + decoys so the child's tripwire behaves identically
    for (const k of ['TRIPWIRE_LOG', 'TRIPWIRE_MODE', 'TRIPWIRE_ALLOW', 'HOME']) {
      if (process.env[k] && !env[k]) env[k] = process.env[k];
    }
  } catch {
    /* ignore */
  }
  return opts;
}

function argvToString(cmd, args) {
  try {
    const parts = [cmd];
    if (Array.isArray(args)) for (const a of args) parts.push(String(a));
    return parts.join(' ');
  } catch {
    return String(cmd || '');
  }
}

function installChildProcessHooks() {
  const cp = require('child_process');

  const wrapSpawnLike = (name, hasArgsArray) => {
    const orig = cp[name];
    if (typeof orig !== 'function') return;
    cp[name] = function (cmd, second, third) {
      try {
        let args = null;
        let opts = null;
        if (Array.isArray(second)) {
          args = second;
          opts = third;
        } else {
          opts = second;
        }
        const line = argvToString(cmd, args);
        const hit = containsDecoy(line);
        log('child_process', `${name}: ${line}`, hit);
        if (opts) fixChildEnv(opts);
      } catch {
        /* ignore */
      }
      return orig.apply(this, arguments);
    };
  };

  for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) wrapSpawnLike(n, true);

  // exec / execSync take a command string, not an argv array.
  for (const n of ['exec', 'execSync']) {
    const orig = cp[n];
    if (typeof orig !== 'function') continue;
    cp[n] = function (command, second, third) {
      try {
        const hit = containsDecoy(command);
        log('child_process', `${n}: ${truncate(command, 200)}`, hit);
        // opts is second arg (exec) — fix env if present
        if (second && typeof second === 'object') fixChildEnv(second);
      } catch {
        /* ignore */
      }
      return orig.apply(this, arguments);
    };
  }
}

// ---- boot -------------------------------------------------------------------
(function boot() {
  try {
    log('tripwire_loaded', `mode=${MODE} pid=${process.pid}`, null);
  } catch {
    /* ignore */
  }
  installFsHooks();
  installEnvProxy();
  installNetHooks();
  installChildProcessHooks();
})();
