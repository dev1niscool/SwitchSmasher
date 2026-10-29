# Switch Smasher

A small browser utility based on [WebRCM by reubenjds](https://github.com/reubenjds/webrcm).

**Site:** https://dev1niscool.github.io/SwitchSmasher/

Retains WebRCM's dark interface, Hekate and Atmosphere version library, release-note links, custom `.bin` uploads, saved selection, USB launch flow, output log, and compatibility instructions. The heading and browser title are **Switch Smasher**, with no subtitle.

The gray footer note is intentionally fixed at **Current Hekate on Switch: Hekate 6.5.4** (`hekate_ctcaer_6.5.4.bin`). It describes the owner's installed version; automated payload updates do not change it.

## Development

Use Node.js 24 and pnpm 10.32.1 (pinned in `package.json`).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
pnpm preview
```

For optional browser checks, install Python Playwright and Chromium, serve the app, then run `python tests/browser-smoke.py http://localhost:5173/` (use `--chromium` if its executable is elsewhere). USB is simulated in this test.

The production build is in `dist/`. Relative asset URLs support the GitHub Pages `/SwitchSmasher/` path and other static HTTPS hosts.

## Releases and deployment

- `.github/workflows/deploy.yml` checks and builds pushes to `main`, then deploys to GitHub Pages. Pages must use **GitHub Actions** as its source.
- `.github/workflows/update-payloads.yml` checks the official [Hekate](https://github.com/ctcaer/hekate/releases) and [Atmosphere](https://github.com/Atmosphere-NX/Atmosphere/releases) latest stable releases daily and on manual dispatch. It downloads payloads, retains up to 10 versions per family, and explicitly dispatches deployment after a bot commit.
- `pnpm update-payloads` runs the same check locally. No third-party download proxy is used.
- Tags matching `v*` build a downloadable `dist.zip` GitHub release.

## Compatibility and verification

WebUSB requires HTTPS (or localhost) and a supported Chromium browser on Linux, macOS, Android, or ChromeOS. Firefox, Safari, iOS, and the upstream Windows USB flow are unsupported. Windows users can use [TegraRcmGUI](https://github.com/eliboa/TegraRcmGUI).

A compatible, unpatched Switch in RCM mode and a USB data cable are required. This method does not add compatibility to patched, Lite, or OLED hardware. Hekate and Atmosphere need their corresponding SD-card files; sending a payload does not install or update them.

Automated checks cover payload layout, mocked USB transfers and failures, release-update failure handling, and the bundled manifest. Browser QA uses mocked USB: a browser can report that it sent the payload, but only the console can confirm that it booted. Physical Switch testing is still required.

## Upstream and credits

Based on WebRCM commit [`33b28e8`](https://github.com/reubenjds/webrcm/commit/33b28e8113deb17443e24a0fa2b2ad5e329ec188). The protocol's payload layout is retained; the derivative also improves device selection, transfer checks, retries, and update/deployment reliability.

- [reubenjds/webrcm](https://github.com/reubenjds/webrcm)
- [Original WebRCM](https://github.com/webrcm/webrcm.github.io)
- [web-fusee-launcher by atlas44](https://github.com/atlas44/web-fusee-launcher)
- [Hekate](https://github.com/CTCaer/hekate) and [Atmosphere](https://github.com/Atmosphere-NX/Atmosphere) retain their respective upstream licenses; bundled binaries are unmodified upstream release assets.

The web application is MIT-licensed; original copyright notices are preserved in [LICENSE](LICENSE). For educational and homebrew purposes. Use at your own risk.
