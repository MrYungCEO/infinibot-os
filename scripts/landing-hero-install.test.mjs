import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const landing = fs.readFileSync(new URL("../docs/landing.html", import.meta.url), "utf8");
const download = fs.readFileSync(new URL("../docs/download.html", import.meta.url), "utf8");
const redirects = fs.readFileSync(new URL("../docs/_redirects", import.meta.url), "utf8");
const config = fs.readFileSync(new URL("../docs/assets/landing/downloads-config.js", import.meta.url), "utf8");

test("hero exposes the requested verified install routes", () => {
  assert.match(landing, /curl -fsSL https:\/\/infinibotos\.com\/install\.sh \| bash/);
  assert.match(landing, /iwr https:\/\/infinibotos\.com\/install\.ps1 \| iex/);
  assert.match(landing, /npm i -g infinibot &amp;&amp; infinibot quickstart/);
  assert.match(landing, /href="https:\/\/cloud\.infinibotos\.com"/);
});

test("hero OS selector is accessible and has all four tabs", () => {
  assert.equal((landing.match(/class="hero-install__tab"/g) || []).length, 4);
  for (const os of ["macos", "linux", "windows", "npm"]) {
    assert.match(landing, new RegExp(`role="tab"[^>]+data-route="${os}"`));
    assert.match(landing, new RegExp(`role="tabpanel" id="ib-inst-${os}"`));
  }
  assert.match(landing, /aria-live="polite" data-copy-live/);
});

test("desktop downloads have one shared launch flag and future-stable routes", () => {
  assert.match(config, /desktopAvailable: true/);
  assert.match(config, /MrYungCEO\/infinibot-desktop-releases/);
  assert.match(redirects, /\/download\/windows\s+https:\/\/github\.com\/MrYungCEO\/infinibot-desktop-releases\/releases\/latest\/download\/InfiniBot-Setup-x64\.exe/);
  assert.match(redirects, /\/download\/linux\s+https:\/\/github\.com\/MrYungCEO\/infinibot-desktop-releases\/releases\/latest\/download\/InfiniBot-x86_64\.AppImage/);
});

test("outdated zip download is retired from public page content", () => {
  assert.doesNotMatch(landing, /infinibot-windows\.zip/);
  assert.doesNotMatch(download, /infinibot-windows\.zip/);
  assert.match(redirects, /\/download\/infinibot-windows\.zip\s+\/download\/windows\s+302/);
});

test("published desktop release is wired with real sizes, digests and asset names", () => {
  assert.doesNotMatch(landing, /coming this week/i);
  assert.doesNotMatch(download, /coming this week/i);
  assert.doesNotMatch(download, /"sha256":"PENDING"/);
  assert.doesNotMatch(download, /infinibot-desktop_amd64\.deb/);
  assert.match(download, /"version":"2026\.10\.8","tag":"v2026\.10\.8"/);
  assert.match(download, /"name":"infinibot_amd64\.deb","href":"\/download\/linux-deb","size":289013658,"sha256":"[a-f0-9]{64}"/);
  assert.match(redirects, /\/download\/linux-deb\s+https:\/\/github\.com\/MrYungCEO\/infinibot-desktop-releases\/releases\/latest\/download\/infinibot_amd64\.deb/);
  assert.match(redirects, /\/download\/SHA256SUMS\s+https:\/\/github\.com\/MrYungCEO\/infinibot-desktop-releases\/releases\/latest\/download\/SHA256SUMS/);
  assert.doesNotMatch(download, /MrYungCEO\/infinibot-releases/);
  assert.match(landing, /href="\/download" data-download-primary/);
});
