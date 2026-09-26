# Rehearsal, milestone-tag & sandbox-settings checklist

The chamber, MCP tools, agent spec and demo rounds are all built and pushed. What remains before the
judged demo is **one human-authored fixture, one sandbox config, and one full agent rehearsal that must be
run and then tagged**. This is the turnkey path. Owners in brackets.

## 0. One-time blockers (do first)

- [ ] **Author + tag color-helper v1.2.4** [C]. Follow `scripts/PAYLOAD_TODO.md` on the `v1.2.4-prep`
      branch of the color-helper repo. Behaviour is spec'd in `demo/fixture-payload.md`. End with
      `git tag v1.2.4 && git push origin main v1.2.4` and delete the TODO file. **Every round's BLOCKED
      case depends on this** — nothing below demonstrates M2/M3 until it exists.
- [ ] **Daytona provider settings** [A]. TrueForge defaults (60 s exec timeout, 5 min idle) are too short:
      a detonation can exceed 60 s and a warmed sandbox would go cold before judges arrive. Apply SPEC §10:
      `GET` the sandbox-providers settings, then `PUT` back with `exec_timeout_ms: 180000`,
      `auto_stop_interval_in_minutes: 30` (paste the redacted api_key from the GET to keep the stored one).
- [ ] **Register the skill in TrueForge** [A]: Settings → Skills, path `skills/supply-chain-gate`, ref
      `main`. Changes to the skill need a push **and a new chat session** to take effect.
- [ ] Confirm the MCP connector `release-ops` is running (`npm run mcp`) with the header secret set, and
      the agent is synced (`npm run agent:sync`).

## 1. Chamber sanity (once v1.2.4 exists) [B]

Run in the sandbox (or locally with `CHAMBER_ROOT` set). Clone URL = tiny-slugify's,
`<slug-sha>` = `git rev-parse` of tiny-slugify HEAD after seeding.

- [ ] `detonate` chalk 5.4.1→5.6.2 → **SAFE** (already verified against real tiny-slugify v1.3.0).
- [ ] `detonate` the color-helper v1.2.3→v1.2.4 bump → **BLOCKED with ≥3 criticals**
      (HONEYTOKEN_READ, TAMPER, DECOY_EXFIL/EXFIL_ATTEMPT, SHIM_INVOKED). *This is the check that has been
      waiting on the fixture; B runs it the moment v1.2.4 tags.*
- [ ] `heal` the color-helper bump → **HEALED** to v1.2.3, tests pass, pin returned.
- [ ] `manifest` at `<slug-sha>` → a `manifest_sha256` (host recomputes the same value before publish;
      verified byte-identical across host/sandbox on v1.2.3 = `c68da10bda66…` for v1.3.0).

## 2. M1 — plain Release Captain (dry-run) [A]

`npm run demo:seed` (round 0), then in a fresh TrueForge chat: **"Ship the next release of tiny-slugify."**

- [ ] commits since the tag are listed → tests run in the sandbox → notes drafted →
      approval cards for tag and publish appear → **dry-run** publish reports the manifest.
- [ ] **Tag it:** `git tag m1 && git push origin m1`. Main is now demoable at M1.

## 3. M2 — detonation [A + B]

- [ ] chalk **SAFE** with intel; color-helper **BLOCKED** with ≥3 criticals; nothing touched on the host.
- [ ] second run gives the **same** verdicts (determinism).
- [ ] `git tag m2 && git push origin m2`.

## 4. M3 — self-heal + ship [A + B]

- [ ] heal report **HEALED**; tests pass with the pin; **three approvals**; `PUBLISH_MODE=live` publish
      succeeds; npm page shows the new version; **manifest matched**; full run under 4 minutes.
- [ ] `git tag m3 && git push origin m3`.

## Rule of thumb

**Only tag a milestone after that milestone's flow has actually run green end-to-end.** A milestone tag is
the fallback you demo from if something breaks after the 16:30 freeze — an untested tag is worse than none.
Never force-push `main`. `PUBLISH_MODE=dry-run` for every rehearsal; `live` only for the final rehearsal
and the judged run.
