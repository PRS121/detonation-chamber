# Fixture payload — what `@quarantine-lab/color-helper@v1.2.4` simulates

This documents the **simulated, benign** malicious behaviour carried by the demo fixture, so judges can
see exactly what the Detonation Chamber catches and why it is safe to run. The fixture is **never published
to npm**; it exists only as a git dependency in our org.

## Interlock (why this is safe to run)

The payload is inert unless **both** `CHAMBER_LAB=1` **and** `CI=true` are set — the two variables the
chamber sets inside a sealed room. A normal `npm install` on anyone's machine is a silent no-op: the very
first line returns before touching anything. It only ever reads **decoy** credentials, only writes inside
the throwaway room, and only ever addresses `collector.color-helper.invalid` — a `.invalid` host that can
never resolve. There is no real exfiltration and no real persistence.

## What v1.2.4 adds over the clean v1.2.3

- The public API is unchanged (`colorize(text, color)`), plus one trivial cosmetic change.
- A new `"postinstall": "node scripts/setup.js"` lifecycle script.
- `scripts/setup.js` is a single obfuscated line: a base64 blob decoded and run through `new Function`,
  the same shape as the real chalk/debug hijack (8 Sep 2025) and the Shai-Hulud worm.

## Behaviour when the interlock is satisfied (inside a room only)

| Step | Simulated malicious action | Tripwire rule it fires |
|---|---|---|
| 1 | Reads the decoy env tokens `NPM_TOKEN`, `GITHUB_TOKEN`, `AWS_ACCESS_KEY_ID` | `HONEYTOKEN_READ` (critical) |
| 2 | Reads the decoy `~/.npmrc` and `~/.aws/credentials` from the room's fake HOME | `HONEYTOKEN_READ` (critical) |
| 3 | Plants `${INIT_CWD}/.github/workflows/color-helper-sync.yml` (a harmless echo workflow) | `TAMPER` (critical) |
| 4 | `fetch()` POSTs the collected decoys to `collector.color-helper.invalid` | `EXFIL_ATTEMPT` + `DECOY_EXFIL` (critical) |
| 5 | Falls back to `curl -X POST … collector.color-helper.invalid` | `SHIM_INVOKED` + `DECOY_EXFIL` (critical) |
| 6 | Swallows every error and exits 0 so the install looks clean | (verdict already BLOCKED) |

Because a decoy value is unique to each room, seeing one leave in a request body or a command line is
proof of exfiltration — not a guess. The verdict is **BLOCKED** on the first critical finding; steps 1–5
each independently justify it, so the demo is robust even if one hook is bypassed.

## How the fixture is built (owned by C)

The readable pre-obfuscation payload is kept out of the fixture repo on purpose (only the obfuscated
`setup.js` ships, like a real dropper). To (re)generate the fixture's `v1.2.4`:

1. Author the readable payload (the six steps above) as a CommonJS function body.
2. Base64-encode it and emit `scripts/setup.js` as
   `try { new Function("require", Buffer.from("<b64>","base64").toString("utf8"))(require); } catch(e){}`
   followed by `process.exit(0)`.
3. Bump `package.json` to `1.2.4`, add the `postinstall`, make the trivial `index.js` change, then
   `git tag v1.2.4`.

> The generation step is intentionally performed by a human: it produces an obfuscated credential-reading
> dropper (benign here, but the exact shape of real malware), so it stays a conscious, reviewed action.

## Decoding it in the demo (step 7 of the agent flow)

When a dependency is BLOCKED and `diff` reports obfuscation, the agent writes a tiny script in the sandbox
that only **decodes** the base64 and prints it — never `eval`/`require`/executes it — and summarises the
six steps above in plain language for the audience.
