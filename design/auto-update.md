# In-app updates

Check GitHub Releases for a newer Clio, surface it quietly, and let the human pull it
down on their own terms. Companion to `README.md`; introduces a status-bar indicator, a
release-notes modal, and a "ready to restart" toast.

---

## Principle: the update never interrupts

Three rules bind every decision here.

1. **Notify, don't push.** A new version appears as a quiet chip in the status bar — the
   same place the engineer already reads `policy: default` and `v0.1.1`, "the way they
   read git branch." Nothing is downloaded, nothing pops, until the human clicks. The
   download is consensual.
2. **The app is the actor, so the color is the human's, never the agent's.** An update is
   user-facing chrome. Copper (`--agent`) is forbidden here. The update vocabulary is
   `--user` (cool blue #8aa6b3) — the human/app identity — across the chip, the modal
   accent, and the ready-toast. It is deliberately *not* an op color (no green "healthy",
   no gold "caution", no red "alarm"): an available update is neither a warning nor a
   success, it is just news.
3. **Dev builds don't check.** `is_dev` (the same `cfg!(debug_assertions)` flag that
   routes secrets to `dev-secrets.json`) suppresses the automatic check, so a local build
   never offers to overwrite itself with a release artifact. A manual "Check for
   Updates…" still works in any build.

---

## The flow (notify-first)

```
launch ──▶ check()            (silent; skipped on dev builds)
            │
            ├─ up to date ───▶ nothing (manual check → "You're on the latest, v0.1.1")
            │
            └─ update found ─▶ status-bar chip:  ↑ 0.2.0
                                  │ click
                                  ▼
                               release-notes modal
                                  │ "Download & Install"
                                  ▼
                               chip:  ↓ 47%      (modal shows a progress bar)
                                  │ install staged
                                  ▼
                               chip:  ↑ Restart   +  toast: "Clio 0.2.0 ready
                                                            [ Restart to update ]"
                                  │ click either
                                  ▼
                               relaunch into the new version
```

The human can ignore the chip indefinitely; it persists (it is state, not a transient)
until they act or the app restarts. Closing the modal leaves the chip in place.

---

## Surfaces

### Status-bar chip

Lives inside `.status-build`, immediately left of the version, sharing that cluster's
far-right anchor. It is the resting indicator and the only always-on update affordance.

| State         | Renders                  | Affordance                              |
| :------------ | :----------------------- | :-------------------------------------- |
| idle/checking | *(nothing)*              | —                                       |
| available     | `↑ 0.2.0`                | click → release-notes modal             |
| downloading   | `↓ 47%`                  | click → modal (progress); not cancelable in v0 |
| ready         | `↑ Restart`              | click → relaunch                        |

Chip chrome rhymes with `.dev-pill` and `.status-reveal-chip` (mono, 10px, `--r-sm`,
soft-wash background + 1px line) but in the `--user` palette: `--user` text on
`--user-wash`, `--user-line` border. The `↑` / `↓` glyphs carry the up-to-date /
in-flight meaning without animation — pulsing is the agent's vocabulary, not the app's.

### Release-notes modal

Reuses the `Modal` primitive. Serif title ("Clio 0.2.0 is available"), the GitHub release
body as release notes (the `notes` field of `latest.json`, rendered as preformatted
text), the from→to versions in mono, and two actions:

- **Download & Install** — primary, `--user` accent. While downloading it is replaced by
  a determinate progress bar; on completion it becomes **Restart to update**.
- **Later** — ghost, closes the modal (chip stays).

### Ready toast

When the install is staged, a `toast` with the new `update` tone (`--user` inset bar)
announces `Clio 0.2.0 ready` with a **Restart to update** action. This is the one
moment the update reaches out — and only *after* the human chose to download, so it is
never an unsolicited interruption.

---

## Tokens

Adds two rgba tokens to `tokens.css` (and its mirror at `src/styles/tokens.css`),
following the `--privacy-soft` / `--privacy-line` precedent, so `--user` gets a usable
wash + line for chip/badge surfaces:

```css
--user-wash:  rgba(138, 166, 179, 0.12);
--user-line:  rgba(138, 166, 179, 0.32);
```

Type: mono 10px for the chip (it shows a version), UI font for the modal body, serif only
for the modal title. Radii: `--r-sm` chip, `--r-md` toast/modal — same as their
neighbors. Motion: the existing `toast-in` (140ms) for the toast; the chip simply appears
(no entrance animation) to stay in the "quiet status" register.

---

## Delivery & trust (out of the UI, but it shapes it)

- **Signing.** Update artifacts are signed with a project **minisign** keypair (Tauri's
  updater signing — independent of Apple codesigning). The public key is pinned in
  `tauri.conf.json`; the private key + password are GitHub Actions secrets. The signature
  is the only trust anchor, so the pubkey must never rotate without a coordinated
  migration.
- **Endpoint.** `https://github.com/nathanenglert/clio/releases/latest/download/latest.json`
  — a public repo, so the updater fetches unauthenticated. CI (`tauri-action`,
  `includeUpdaterJson: true`) generates and uploads `latest.json` + the signed
  `.app.tar.gz`.
- **The publish gate stays.** release-please cuts a *draft* release; `latest.json` is not
  reachable until a human publishes it. That manual publish is the "ship this update to
  users" control — the updater only ever sees published releases.
- **Notarization is a separate track.** The app is ad-hoc signed today (no Apple
  Developer account). In-place updates still relaunch because the updater swaps the
  bundle itself (no quarantine xattr). The known caveat: an ad-hoc signature changes per
  build, which can re-prompt macOS keychain access after an update — notarization (a
  stable Developer ID identity, already on the v0.2 path) is what makes that seamless.
  This feature is forward-compatible with notarization landing later.
