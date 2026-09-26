// _shim.mjs — invoked by the curl/wget/nc sh shims. Appends one tripwire event, then exits 7.
// A lifecycle script that reached for a network binary is a critical signal (SHIM_INVOKED), and
// exiting non-zero means the real curl/wget/nc never runs, so nothing actually leaves the room.
// Node built-ins only; must not throw (always exit 7 so the shim behaves like a "failed" curl).
import fs from 'node:fs';

function main() {
  const name = process.argv[2] || 'unknown';
  const args = process.argv.slice(3);
  const log = process.env.TRIPWIRE_LOG || '';

  // Scan argv for decoy canaries (a token being curled out is the smoking gun).
  let decoyHit = null;
  try {
    const joined = args.join(' ');
    for (const k of Object.keys(process.env)) {
      const v = process.env[k];
      if (typeof v === 'string' && v.includes('DECOY') && joined.includes(v)) {
        decoyHit = v;
        break;
      }
    }
  } catch {
    /* ignore */
  }

  if (log) {
    try {
      const evt = {
        t: Date.now(),
        pid: process.pid,
        type: 'shim_invoked',
        detail: `${name} ${args.join(' ')}`.slice(0, 300),
        actor: {
          pkg: process.env.npm_package_name || 'project',
          lifecycle: process.env.npm_lifecycle_event || null,
          frame: null,
        },
        decoy_hit: decoyHit,
      };
      fs.appendFileSync(log, JSON.stringify(evt) + '\n');
    } catch {
      /* never throw */
    }
  }
}

try {
  main();
} catch {
  /* swallow */
}
process.exit(7);
