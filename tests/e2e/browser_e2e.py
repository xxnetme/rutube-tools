#!/usr/bin/env python3
"""Настоящий browser E2E: локальный RuTube, временное расширение, MP4 + ffprobe.

Браузер идёт только через CONNECT-прокси. Разрешённые имена RuTube/CDN туннелируются
на локальный HTTPS-стенд, остальные соединения отклоняются и проваливают проверку.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import select
import shutil
import socket
import socketserver
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.firefox.options import Options as FirefoxOptions
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tmp" / "e2e"
VIDEO_ID = "0123456789abcdef0123456789abcdef"
ALLOWED_HOST = re.compile(r"(^|\.)(rutube\.ru|rtbcdn\.ru|rtbcdn\.net)$", re.I)


def log(message: str) -> None:
    print(f"[e2e] {message}", flush=True)


def allowed_host(host: str) -> bool:
    return bool(ALLOWED_HOST.search(host.rstrip(".").lower()))


class Recorder:
    def __init__(self) -> None:
        self.entries: list[dict] = []
        self.lock = threading.Lock()

    def add(self, entry: dict) -> None:
        with self.lock:
            self.entries.append(dict(entry))

    def snapshot(self) -> list[dict]:
        with self.lock:
            return list(self.entries)


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        self.request.settimeout(35)
        upstream = None
        try:
            data = b""
            while b"\r\n\r\n" not in data and len(data) < 16384:
                chunk = self.request.recv(4096)
                if not chunk:
                    return
                data += chunk
            head, _, tail = data.partition(b"\r\n\r\n")
            lines = head.decode("latin1", "replace").split("\r\n")
            method, target, _ = lines[0].split(" ", 2)
            if method.upper() != "CONNECT":
                host = ""
                if target.startswith("http"):
                    host = urllib.parse.urlsplit(target).hostname or ""
                else:
                    for line in lines[1:]:
                        if line.lower().startswith("host:"):
                            host = line.split(":", 1)[1].strip().split(":")[0]
                ok = allowed_host(host)
                self.server.recorder.add({"kind": "http", "host": host, "target": target, "allowed": ok})
                self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return

            host, port_text = target.rsplit(":", 1)
            host = host.strip("[]").lower()
            port = int(port_text)
            local_target = host in ("127.0.0.1", "localhost") and port == self.server.https_port
            ok = (port == 443 and allowed_host(host)) or local_target
            self.server.recorder.add({"kind": "connect", "host": host, "port": port, "allowed": ok})
            if not ok:
                self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return

            upstream = socket.create_connection(("127.0.0.1", self.server.https_port), timeout=12)
            upstream.settimeout(35)
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            if tail:
                upstream.sendall(tail)
            sockets = [self.request, upstream]
            while True:
                readable, _, _ = select.select(sockets, [], [], 35)
                if not readable:
                    return
                for source in readable:
                    chunk = source.recv(65536)
                    if not chunk:
                        return
                    (upstream if source is self.request else self.request).sendall(chunk)
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError, ValueError):
            return
        finally:
            if upstream is not None:
                try:
                    upstream.close()
                except OSError:
                    pass


class ProxyServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


class RuTubeHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:
        return

    def send_data(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 — API BaseHTTPRequestHandler
        path = urllib.parse.urlsplit(self.path).path
        host = (self.headers.get("Host") or "").split(":")[0]
        self.server.recorder.add({"kind": "https", "host": host, "path": path,
                                  "allowed": allowed_host(host)})
        if path == "/favicon.ico":
            return self.send_data(204, b"", "image/x-icon")
        if path == f"/video/{VIDEO_ID}/":
            html = f"""<!doctype html><html lang='ru'><head><meta charset='utf-8'>
<title>E2E RuTube</title></head><body><h1>Локальный стенд</h1>
<video id='video' controls preload='none'></video>
</body></html>""".encode()
            return self.send_data(200, html, "text/html; charset=utf-8")
        if path == f"/api/play/options/{VIDEO_ID}/":
            payload = {
                "title": "E2E: локальный стенд",
                "author": {"name": "xxnetme"},
                "duration": 2000,
                "video_balancer": {"default": f"https://cdn.rtbcdn.ru/{VIDEO_ID}/master.m3u8"},
                "captions": [], "cuepoints": [], "live_streams": [], "thumbnail_url": ""
            }
            return self.send_data(200, json.dumps(payload).encode(), "application/json")
        if path == f"/{VIDEO_ID}/master.m3u8":
            master = f"""#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=160x90,FRAME-RATE=10.0,CODECS=\"avc1.42c00c,mp4a.40.2\"
https://cdn.rtbcdn.ru/{VIDEO_ID}/90/index.m3u8
"""
            return self.send_data(200, master.encode(), "application/vnd.apple.mpegurl")
        if path == f"/{VIDEO_ID}/90/index.m3u8":
            body = (self.server.media / "index.m3u8").read_bytes()
            return self.send_data(200, body, "application/vnd.apple.mpegurl")
        match = re.fullmatch(rf"/{VIDEO_ID}/90/(segment\d+\.ts)", path)
        if match:
            segment = self.server.media / match.group(1)
            if segment.exists():
                return self.send_data(200, segment.read_bytes(), "video/mp2t")
        return self.send_data(404, b"not found", "text/plain")


def generate_media(work: Path) -> Path:
    media = work / "media"
    media.mkdir(parents=True)
    subprocess.run([
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "2", "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
        "-g", "10", "-c:a", "aac", "-b:a", "64k",
        "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod",
        "-hls_segment_filename", str(media / "segment%d.ts"), str(media / "index.m3u8")
    ], check=True)
    return media


def generate_certificate(work: Path) -> tuple[Path, Path]:
    cert, key = work / "cert.pem", work / "key.pem"
    san = "DNS:rutube.ru,DNS:*.rutube.ru,DNS:rtbcdn.ru,DNS:*.rtbcdn.ru,DNS:rtbcdn.net,DNS:*.rtbcdn.net"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=rutube.ru", "-addext", f"subjectAltName={san}",
        "-keyout", str(key), "-out", str(cert)
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return cert, key


def browser_binary(name: str) -> str:
    env = os.environ.get(name.upper() + "_BINARY")
    if env and Path(env).exists():
        return env
    script = f"process.stdout.write(require('playwright').{name}.executablePath())"
    path = subprocess.check_output(["node", "-e", script], cwd=ROOT, text=True)
    if not Path(path).exists():
        raise RuntimeError(f"Нет браузера {name}: {path}. Выполните npx playwright install {name}")
    return path


def shadow(driver, selector: str):
    return driver.execute_script("""
      const host = document.querySelector('#rt-tools-host');
      return host && host.shadowRoot ? host.shadowRoot.querySelector(arguments[0]) : null;
    """, selector)


def shadow_text(driver) -> str:
    return driver.execute_script("""
      const host = document.querySelector('#rt-tools-host');
      const body = host && host.shadowRoot && host.shadowRoot.querySelector('.bd');
      return body ? body.textContent : '';
    """)


def make_driver(name: str, proxy_port: int, directory: Path) -> webdriver.Remote:
    proxy = f"http://127.0.0.1:{proxy_port}"
    if name == "chromium":
        options = ChromeOptions()
        options.binary_location = browser_binary(name)
        options.accept_insecure_certs = True
        extension = str(ROOT / "build" / "rutube-tools-chromium")
        for arg in [
            "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
            f"--proxy-server={proxy}", "--ignore-certificate-errors",
            f"--load-extension={extension}", f"--disable-extensions-except={extension}",
            "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
            "--disable-sync", "--metrics-recording-only", "--no-first-run", "--no-default-browser-check",
            "--disable-client-side-phishing-detection", "--safebrowsing-disable-auto-update",
            "--disable-features=MediaRouter,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled"
        ]:
            options.add_argument(arg)
        options.add_experimental_option("prefs", {
            "download.default_directory": str(directory), "download.prompt_for_download": False,
            "download.directory_upgrade": True, "safebrowsing.enabled": False
        })
        driver = webdriver.Chrome(options=options)
    else:
        options = FirefoxOptions()
        options.binary_location = browser_binary(name)
        options.accept_insecure_certs = True
        options.add_argument("-headless")
        prefs = {
            "network.proxy.type": 1,
            "network.proxy.http": "127.0.0.1", "network.proxy.http_port": proxy_port,
            "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": proxy_port,
            "network.proxy.no_proxies_on": "", "network.proxy.failover_direct": False,
            "browser.download.folderList": 2, "browser.download.dir": str(directory),
            "browser.download.useDownloadDir": True,
            "browser.download.manager.showWhenStarting": False,
            "browser.download.alwaysOpenPanel": False,
            "browser.helperApps.neverAsk.saveToDisk": "video/mp4,audio/mp4,video/mp2t,application/octet-stream,binary/octet-stream",
            "xpinstall.signatures.required": False,
            "extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15,
            "app.update.auto": False, "app.update.enabled": False,
            "extensions.update.enabled": False, "extensions.systemAddon.update.enabled": False,
            "datareporting.healthreport.uploadEnabled": False,
            "datareporting.policy.dataSubmissionEnabled": False,
            "toolkit.telemetry.enabled": False, "toolkit.telemetry.unified": False,
            "browser.safebrowsing.phishing.enabled": False, "browser.safebrowsing.malware.enabled": False,
            "browser.safebrowsing.downloads.enabled": False,
            "network.captive-portal-service.enabled": False, "network.connectivity-service.enabled": False,
            "browser.newtabpage.activity-stream.feeds.system.topstories": False,
            "browser.newtabpage.activity-stream.showSponsored": False,
            "browser.search.update": False, "app.normandy.enabled": False,
            "browser.startup.homepage": "about:blank"
        }
        for key, value in prefs.items():
            options.set_preference(key, value)
        driver = webdriver.Firefox(options=options)
        addon = driver.install_web_extension(
            str(ROOT / "release" / "rutube-tools-firefox.xpi"), permanent=False)
        log(f"Firefox temporary add-on: {getattr(addon, 'id', addon)}")
    driver.set_page_load_timeout(45)
    return driver


def wait_download(directory: Path, timeout: int = 45) -> Path:
    deadline = time.time() + timeout
    candidate = None
    while time.time() < deadline:
        files = sorted(directory.glob("*.mp4"))
        partial = list(directory.glob("*.crdownload")) + list(directory.glob("*.part"))
        if files and not partial and files[0].stat().st_size > 0:
            candidate = files[0]
            first = candidate.stat().st_size
            time.sleep(1)
            if candidate.exists() and candidate.stat().st_size == first:
                return candidate
        time.sleep(0.25)
    raise AssertionError(f"MP4 не появился в {directory}; файлы: {[p.name for p in directory.iterdir()]}")


def probe(path: Path) -> dict:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries",
        "format=format_name,duration,size:stream=codec_type,codec_name", "-of", "json", str(path)
    ], check=True, text=True, capture_output=True)
    data = json.loads(result.stdout)
    kinds = {s.get("codec_type") for s in data.get("streams", [])}
    codecs = {s.get("codec_name") for s in data.get("streams", [])}
    duration = float(data["format"].get("duration") or 0)
    assert "mp4" in data["format"].get("format_name", ""), data
    assert {"video", "audio"}.issubset(kinds), data
    assert {"h264", "aac"}.issubset(codecs), data
    assert 0.5 < duration < 10, data
    return data


def exercise_popup_settings(driver, directory: Path) -> dict:
    """Popup в настоящем Chromium: импорт, отказ схемы и откат ошибки storage."""
    targets = driver.execute_cdp_cmd("Target.getTargets", {})["targetInfos"]
    extension_ids = [t["url"].split("/")[2] for t in targets if t["url"].startswith("chrome-extension://")]
    assert extension_ids, targets
    driver.get(f"chrome-extension://{extension_ids[0]}/popup.html")
    WebDriverWait(driver, 15).until(lambda d: d.find_element("id", "importFile"))

    def write_backup(name: str, settings: dict) -> Path:
        path = directory / name
        path.write_text(json.dumps({
            "app": "rutube-tools", "schemaVersion": 1, "settings": settings
        }), encoding="utf-8")
        return path

    def status_after(path: Path) -> str:
        driver.execute_script("document.querySelector('#backupStatus').textContent = ''")
        driver.find_element("id", "importFile").send_keys(str(path))
        return WebDriverWait(driver, 15).until(
            lambda d: d.find_element("id", "backupStatus").text)

    def stored() -> dict:
        return driver.execute_async_script(
            "const done = arguments[arguments.length - 1]; chrome.storage.local.get(null).then(done)")

    valid = write_backup("settings-valid.json", {
        "quality": "1080", "maxPartMB": 400, "nameTemplate": "<img src=x>", "futureKey": 1
    })
    assert status_after(valid)
    data = stored()
    assert data["quality"] == "1080" and data["maxPartMB"] == 400
    assert "futureKey" not in data
    assert driver.find_element("id", "nameTemplate").get_attribute("value") == "<img src=x>"
    assert not driver.find_elements("css selector", 'img[src="x"]')

    invalid = write_backup("settings-invalid.json", {"quality": 720})
    assert status_after(invalid)
    assert stored()["quality"] == "1080", "невалидный файл изменил настройки"

    other = write_backup("settings-rollback.json", {"quality": "720"})
    driver.execute_script("""
      window.__setCalls = [];
      window.__originalSet = chrome.storage.local.set.bind(chrome.storage.local);
      window.__failSet = true;
      chrome.storage.local.set = function (data) {
        window.__setCalls.push(data);
        if (window.__failSet) {
          window.__failSet = false;
          return Promise.reject(new Error('forced E2E write failure'));
        }
        return window.__originalSet(data);
      };
    """)
    assert status_after(other)
    calls = driver.execute_script("return window.__setCalls.map(function (x) { return x.quality; })")
    assert calls == ["720", "1080"], calls
    assert stored()["quality"] == "1080", "rollback не восстановил прежнее значение"
    return {"validImport": "passed", "invalidRejected": "passed", "writeRollback": "passed"}


def run_browser(name: str, proxy_port: int, proxy_log: Recorder, https_log: Recorder) -> dict:
    directory = OUT / name
    directory.mkdir(parents=True, exist_ok=True)
    proxy_start, https_start = len(proxy_log.entries), len(https_log.entries)
    driver = None
    report = {"browser": name, "status": "failed"}
    try:
        log(f"{name}: запуск")
        driver = make_driver(name, proxy_port, directory)
        report["version"] = driver.capabilities.get("browserVersion")
        driver.get(f"https://rutube.ru/video/{VIDEO_ID}/")
        WebDriverWait(driver, 35).until(lambda d: shadow(d, ".pill"))
        driver.execute_script("arguments[0].click()", shadow(driver, ".pill"))
        WebDriverWait(driver, 35).until(lambda d: shadow(d, '[data-act="go"]'))
        assert "E2E: локальный стенд" in shadow_text(driver), shadow_text(driver)
        driver.execute_script("arguments[0].click()", shadow(driver, '[data-act="go"]'))

        def finished(d):
            state = d.execute_script("""
              const host = document.querySelector('#rt-tools-host');
              const body = host && host.shadowRoot && host.shadowRoot.querySelector('.bd');
              if (!body) return {state: 'missing', text: ''};
              const error = body.querySelector('.err');
              if (error) return {state: 'error', text: body.textContent};
              if (body.querySelector('.ok')) return {state: 'done', text: body.textContent};
              return {state: 'running', text: body.textContent};
            """)
            if state["state"] == "error":
                return {"error": state["text"]}
            if state["state"] == "done":
                return {"done": state["text"]}
            return None

        result = WebDriverWait(driver, 60).until(finished)
        if "error" in result:
            raise AssertionError("Панель сообщила ошибку: " + result["error"])
        downloaded = wait_download(directory)
        assert downloaded.stat().st_size > 1000, downloaded
        media_info = probe(downloaded)
        report.update({
            "file": downloaded.name, "bytes": downloaded.stat().st_size,
            "ffprobe": media_info
        })
        if name == "chromium":
            report["popupSettings"] = exercise_popup_settings(driver, directory)
    except Exception as exc:
        report["error"] = str(exc)
        if driver is not None:
            try:
                (OUT / f"{name}-page.txt").write_text(shadow_text(driver), encoding="utf-8")
                driver.save_screenshot(str(OUT / f"{name}-failure.png"))
            except Exception:
                pass
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass
        time.sleep(0.5)
        report["network"] = {
            "proxy": proxy_log.snapshot()[proxy_start:], "https": https_log.snapshot()[https_start:]
        }
        (OUT / f"{name}-network.json").write_text(
            json.dumps(report["network"], ensure_ascii=False, indent=2), encoding="utf-8")

        errors = [report["error"]] if report.get("error") else []
        bad = [e for e in report["network"]["proxy"] + report["network"]["https"] if not e.get("allowed")]
        if bad:
            errors.append("Запросы вне allowlist: " + json.dumps(bad, ensure_ascii=False))
        paths = [e.get("path", "") for e in report["network"]["https"]]
        required = [f"/api/play/options/{VIDEO_ID}/", f"/{VIDEO_ID}/master.m3u8", f"/{VIDEO_ID}/90/index.m3u8"]
        if not all(path in paths for path in required) or not any(path.endswith(".ts") for path in paths):
            errors.append("Не все ожидаемые API/HLS-запросы прошли: " + json.dumps(paths))
        report["status"] = "failed" if errors else "passed"
        if errors:
            report["error"] = "; ".join(errors)
        else:
            report.pop("error", None)
        (OUT / f"{name}-report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    if report["status"] != "passed":
        raise AssertionError(report["error"])
    log(f"{name}: {report['file']}, {report['bytes']} байт, ffprobe MP4 OK")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=("chromium", "firefox", "all"), default="all")
    args = parser.parse_args()
    if OUT.exists():
        shutil.rmtree(OUT)
    work = OUT / "work"
    work.mkdir(parents=True)
    media = generate_media(work)
    cert, key = generate_certificate(work)
    subprocess.run([sys.executable, "build.py"], cwd=ROOT, check=True)

    proxy_log, https_log = Recorder(), Recorder()
    https = ThreadingHTTPServer(("127.0.0.1", 0), RuTubeHandler)
    https.media = media
    https.recorder = https_log
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    https.socket = context.wrap_socket(https.socket, server_side=True)
    proxy = ProxyServer(("127.0.0.1", 0), ProxyHandler)
    proxy.https_port = https.server_address[1]
    proxy.recorder = proxy_log
    threading.Thread(target=https.serve_forever, daemon=True).start()
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    log(f"HTTPS :{https.server_address[1]}, прокси :{proxy.server_address[1]}")

    names = ["chromium", "firefox"] if args.browser == "all" else [args.browser]
    failures = []
    try:
        for name in names:
            try:
                run_browser(name, proxy.server_address[1], proxy_log, https_log)
            except Exception as exc:
                failures.append(f"{name}: {exc}")
                log(f"{name}: FAIL — {exc}")
    finally:
        proxy.shutdown()
        https.shutdown()
        proxy.server_close()
        https.server_close()
    if failures:
        raise SystemExit("\n".join(failures))
    log("все браузерные сценарии прошли")


if __name__ == "__main__":
    main()
