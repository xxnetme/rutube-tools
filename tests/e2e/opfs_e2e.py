#!/usr/bin/env python3
"""Production OPFS E2E: RTLib.downloadPart, resume, export and recovery.

The regular browser_e2e.py checks the user-facing HLS flow. This suite deliberately
uses the same bundled engine and Media adapter in an extension page so that OPFS
is tested without replacing it with a toy Worker-only benchmark.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path

from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tmp" / "opfs-production"
sys.path.insert(0, str(ROOT / "tests" / "e2e"))
import browser_e2e as base  # noqa: E402


def extension_page(driver, name: str) -> None:
    if name == "chromium":
        targets = driver.execute_cdp_cmd("Target.getTargets", {})["targetInfos"]
        ids = [t["url"].split("/")[2] for t in targets
               if t["url"].startswith("chrome-extension://")]
        if not ids:
            raise AssertionError(f"extension target not found: {targets}")
        driver.get(f"chrome-extension://{ids[0]}/popup.html")
    else:
        driver.set_context(driver.CONTEXT_CHROME)
        uuid = driver.execute_script(
            "return WebExtensionPolicy.getByID('rutube-tools@xxnetme.github.io').mozExtensionHostname"
        )
        driver.set_context(driver.CONTEXT_CONTENT)
        driver.get(f"moz-extension://{uuid}/popup.html")
    WebDriverWait(driver, 20).until(lambda d: d.execute_script("return !!globalThis.RTSettings"))
    driver.execute_async_script("""
      const done = arguments[arguments.length - 1];
      const files = ['lib/network.js', 'lib/mux-mp4.min.js', 'lib/media.js',
                     'lib/engine.js', 'lib/audio.js'];
      Promise.all(files.map(src => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error('load: ' + src));
        document.head.appendChild(script);
      }))).then(() => done(true), error => done(String(error)));
    """)
    WebDriverWait(driver, 20).until(lambda d: d.execute_script(
        "return !!(globalThis.RTLib && globalThis.RTMedia && globalThis.RTNetwork)"
    ))


def run_page_suite(driver, name: str) -> dict:
    """Run all async checks in the extension's real JS realm."""
    fixtures = {
        "hevc": base64.b64encode((ROOT / "tests" / "fixtures" / "hevc-aac.ts").read_bytes()).decode(),
        "av1": base64.b64encode((ROOT / "tests" / "fixtures" / "av1-aac.mp4").read_bytes()).decode(),
    }
    result = driver.execute_async_script(r"""
      const fixtureData = arguments[0];
      const done = arguments[arguments.length - 1];
      (async () => {
        const api = globalThis.browser || globalThis.chrome;
        const segments = [
          'https://cdn.rtbcdn.ru/0123456789abcdef0123456789abcdef/90/segment0.ts',
          'https://cdn.rtbcdn.ru/0123456789abcdef0123456789abcdef/90/segment1.ts'
        ];
        const fingerprint = segments.join('\n');
        const report = {};
        const cfg = (key, extra) => Object.assign({
          segments, mode: 'mp4', concurrency: 1, opfs: true,
          resumeKey: key, fingerprint, expectedDurationSec: 2,
          validate: true, media: RTMedia, muxjs: globalThis.muxjs
        }, extra || {});
        const compact = out => ({
          ext: out.ext, bytes: out.bytes, durationSec: out.durationSec,
          tracks: out.tracks, fileBytes: out.file && out.file.size,
          opfsKey: out.opfsKey || null
        });

        // Abort only after the first durable segment/index write. The second run
        // must resume at segment 1 and must not fetch segment 0 again.
        const key = 'e2e-resume-' + Date.now();
        const requests = [];
        const originalFetch = RTNetwork.fetch;
        RTNetwork.fetch = function (url, opts) {
          requests.push(url);
          return originalFetch.call(RTNetwork, url, opts);
        };
        const controller = new AbortController();
        let firstError = '';
        let firstSaved = 0;
        try {
          await RTLib.downloadPart(cfg(key, {
            signal: controller.signal,
            onSegmentSaved(info) {
              firstSaved = info.nextSegment || 0;
              if (firstSaved === 1) controller.abort();
            }
          }));
        } catch (error) { firstError = String(error && error.message || error); }
        const afterFirst = requests.slice();
        let storage = [];
        const resumed = await RTLib.downloadPart(cfg(key, {
          onStorage(info) { storage.push(info); }
        }));
        report.resume = {
          firstError, firstSaved, afterFirst, requests,
          storage, output: compact(resumed)
        };
        await RTMedia.cleanupOpfs(key);
        RTNetwork.fetch = originalFetch;

        // A malformed index must invalidate the input, not append to corrupt data.
        const corruptKey = 'e2e-corrupt-' + Date.now();
        const firstResponse = await RTNetwork.fetch(segments[0], {credentials: 'omit'});
        const firstBytes = new Uint8Array(await firstResponse.arrayBuffer());
        let session = await RTMedia.createOpfsSession({
          key: corruptKey, total: 2, fingerprint, expectedBytes: 0
        });
        await session.write(firstBytes, 0);
        await session.close();
        const root = await navigator.storage.getDirectory();
        const indexHandle = await root.getFileHandle('rt-v2-' + corruptKey + '.json');
        const writable = await indexHandle.createWritable();
        await writable.write('{not-json');
        await writable.close();
        session = await RTMedia.createOpfsSession({
          key: corruptKey, total: 2, fingerprint, expectedBytes: 0
        });
        report.corruptIndex = {nextSegment: session.nextSegment, bytes: session.bytes};
        await session.close();
        await RTMedia.cleanupOpfs(corruptKey);

        // Deterministic quota refusal: the engine must retain the old memory path.
        const quotaStates = [];
        const quotaOut = await RTLib.downloadPart(cfg('e2e-quota-' + Date.now(), {
          expectedBytes: Number.MAX_SAFE_INTEGER,
          onStorage(info) { quotaStates.push(info); }
        }));
        report.quotaFallback = {storage: quotaStates, output: compact(quotaOut)};

        // The same autonomous bundle must carry HEVC/AV1 in a real browser,
        // including the codec configuration boxes, not only in Node.
        const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
        const hasBox = (out, name) => {
          const bytes = out.chunks.reduce((all, chunk) => {
            const joined = new Uint8Array(all.length + chunk.length);
            joined.set(all, 0); joined.set(chunk, all.length); return joined;
          }, new Uint8Array());
          const text = Array.from(bytes, b => String.fromCharCode(b)).join('');
          return text.includes(name);
        };
        const hevc = await RTMedia.transmuxChunks([decode(fixtureData.hevc)], {expectedDurationSec: 1.024});
        const av1 = await RTMedia.transmuxChunks([decode(fixtureData.av1)], {expectedDurationSec: 1});
        report.codecs = {
          hevc: {output: compact(hevc), hvcC: hasBox(hevc, 'hvcC')},
          av1: {output: compact(av1), av1C: hasBox(av1, 'av1C')}
        };

        // Actual OPFS File -> object URL -> browser downloads export.
        const exportKey = 'e2e-export-' + Date.now();
        const exported = await RTLib.downloadPart(cfg(exportKey));
        const url = URL.createObjectURL(exported.file);
        const downloadId = await api.downloads.download({
          url, filename: 'rutube-opfs-e2e-' + (globalThis.browser ? 'firefox' : 'chromium') + '.mp4',
          conflictAction: 'uniquify'
        });
        report.export = {downloadId, key: exportKey, output: compact(exported)};
        // Keep the URL and output alive until Python verifies the downloaded file.
        globalThis.__opfsE2E = {url, exportKey};
        return report;
      })().then(value => done({ok: true, report: value}),
               error => done({ok: false, error: String(error && error.message || error),
                              code: error && error.code, stack: error && error.stack}));
    """, fixtures)
    if not result.get("ok"):
        raise AssertionError(json.dumps(result, ensure_ascii=False))
    report = result["report"]
    resume = report["resume"]
    assert resume["firstSaved"] == 1, resume
    assert resume["firstError"], resume
    assert resume["storage"] and resume["storage"][0].get("resumed") is True, resume
    assert len(resume["afterFirst"]) == 1, resume
    assert len(resume["requests"]) == 2, resume
    assert resume["output"]["ext"] == "mp4", resume
    assert resume["output"]["fileBytes"] > 1000, resume
    assert report["corruptIndex"] == {"nextSegment": 0, "bytes": 0}, report["corruptIndex"]
    assert report["quotaFallback"]["storage"][0]["state"] == "memory", report["quotaFallback"]
    assert report["quotaFallback"]["output"]["ext"] == "mp4", report["quotaFallback"]
    assert report["export"]["output"]["fileBytes"] > 1000, report["export"]
    assert report["codecs"]["hevc"]["hvcC"] is True, report["codecs"]
    assert report["codecs"]["av1"]["av1C"] is True, report["codecs"]
    assert {t["codec"] for t in report["codecs"]["hevc"]["output"]["tracks"]} == {"hevc", "aac"}
    assert {t["codec"] for t in report["codecs"]["av1"]["output"]["tracks"]} == {"av1", "aac"}
    return report


def run_browser(name: str, proxy_port: int, proxy_log: base.Recorder, https_log: base.Recorder) -> dict:
    directory = OUT / name
    directory.mkdir(parents=True, exist_ok=True)
    driver = None
    report = {"browser": name, "status": "failed"}
    try:
        if name == "firefox":
            os.environ["MOZ_REMOTE_ALLOW_SYSTEM_ACCESS"] = "1"
        driver = base.make_driver(name, proxy_port, directory)
        report["version"] = driver.capabilities.get("browserVersion")
        extension_page(driver, name)
        report.update(run_page_suite(driver, name))
        downloaded = base.wait_download(directory, timeout=60)
        media_info = base.probe(downloaded)
        report["downloaded"] = {"name": downloaded.name, "bytes": downloaded.stat().st_size,
                                "ffprobe": media_info}
        driver.execute_async_script("""
          const done = arguments[arguments.length - 1];
          (async () => {
            if (globalThis.__opfsE2E) {
              URL.revokeObjectURL(globalThis.__opfsE2E.url);
              await RTMedia.cleanupOpfs(globalThis.__opfsE2E.exportKey);
            }
            const root = await navigator.storage.getDirectory();
            const estimate = await navigator.storage.estimate();
            done({usage: estimate.usage || 0, quota: estimate.quota || 0});
          })().catch(error => done({error: String(error)}));
        """)
        report["status"] = "passed"
    except Exception as exc:
        report["error"] = str(exc)
        if driver is not None:
            try:
                driver.save_screenshot(str(OUT / f"{name}-failure.png"))
            except Exception:
                pass
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass
        report["network"] = {"proxy": proxy_log.snapshot(), "https": https_log.snapshot()}
        bad = [e for e in report["network"]["proxy"] + report["network"]["https"] if not e.get("allowed")]
        if bad:
            report["status"] = "failed"
            report["error"] = "Запросы вне allowlist: " + json.dumps(bad, ensure_ascii=False)
        (OUT / f"{name}-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if report["status"] != "passed":
        raise AssertionError(report.get("error", "OPFS E2E failed"))
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=("chromium", "firefox", "all"), default="all")
    args = parser.parse_args()
    if OUT.exists():
        shutil.rmtree(OUT)
    work = OUT / "work"
    work.mkdir(parents=True)
    media = base.generate_media(work)
    cert, key = base.generate_certificate(work)
    subprocess.run([sys.executable, "build.py"], cwd=ROOT, check=True)
    proxy_log, https_log = base.Recorder(), base.Recorder()
    https = base.ThreadingHTTPServer(("127.0.0.1", 0), base.RuTubeHandler)
    https.media = media
    https.recorder = https_log
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    https.socket = context.wrap_socket(https.socket, server_side=True)
    proxy = base.ProxyServer(("127.0.0.1", 0), base.ProxyHandler)
    proxy.https_port = https.server_address[1]
    proxy.recorder = proxy_log
    threading.Thread(target=https.serve_forever, daemon=True).start()
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    names = ["chromium", "firefox"] if args.browser == "all" else [args.browser]
    failures = []
    try:
        for name in names:
            try:
                report = run_browser(name, proxy.server_address[1], proxy_log, https_log)
                print(f"[opfs-e2e] {name}: passed, {report['downloaded']['bytes']} bytes", flush=True)
            except Exception as exc:
                failures.append(f"{name}: {exc}")
                print(f"[opfs-e2e] {name}: FAIL — {exc}", flush=True)
    finally:
        proxy.shutdown()
        https.shutdown()
        proxy.server_close()
        https.server_close()
    if failures:
        raise SystemExit("\n".join(failures))


if __name__ == "__main__":
    main()
