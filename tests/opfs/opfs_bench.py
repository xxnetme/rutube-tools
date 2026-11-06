#!/usr/bin/env python3
"""Воспроизводимый OPFS/Blob benchmark в настоящих Firefox и Chromium.

Linux RSS — суммарный VmRSS дерева WebDriver + браузерных процессов. Это метрика
процесса, а не точный размер Blob/OPFS; абсолютные значения между браузерами не сравниваем.
"""
from __future__ import annotations

import argparse
import functools
import json
import os
import platform
import shutil
import subprocess
import threading
import time
import urllib.request
import zlib
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.firefox.options import Options as FirefoxOptions

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tmp" / "opfs"
MIB = 1024 * 1024
BASE_PATTERN = bytes(range(256))


def log(message: str) -> None:
    print(f"[opfs] {message}", flush=True)


def browser_binary(name: str) -> str:
    env = os.environ.get(name.upper() + "_BINARY")
    if env and Path(env).exists():
        return env
    script = f"process.stdout.write(require('playwright').{name}.executablePath())"
    path = subprocess.check_output(["node", "-e", script], cwd=ROOT, text=True)
    if not Path(path).exists():
        raise RuntimeError(f"Нет браузера {name}: {path}. Выполните npx playwright install {name}")
    return path


def make_driver(name: str):
    if name == "chromium":
        options = ChromeOptions()
        options.binary_location = browser_binary(name)
        for arg in [
            "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
            "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
            "--disable-sync", "--metrics-recording-only", "--no-first-run", "--no-default-browser-check",
            "--disable-features=MediaRouter,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled"
        ]:
            options.add_argument(arg)
        return webdriver.Chrome(options=options)
    options = FirefoxOptions()
    options.binary_location = browser_binary(name)
    options.add_argument("-headless")
    prefs = {
        "app.update.auto": False, "app.update.enabled": False,
        "extensions.update.enabled": False, "extensions.systemAddon.update.enabled": False,
        "datareporting.healthreport.uploadEnabled": False,
        "datareporting.policy.dataSubmissionEnabled": False,
        "toolkit.telemetry.enabled": False, "toolkit.telemetry.unified": False,
        "browser.safebrowsing.phishing.enabled": False, "browser.safebrowsing.malware.enabled": False,
        "network.captive-portal-service.enabled": False, "network.connectivity-service.enabled": False,
        "browser.newtabpage.activity-stream.feeds.system.topstories": False,
        "browser.newtabpage.activity-stream.showSponsored": False,
        "browser.search.update": False, "app.normandy.enabled": False,
        "browser.startup.homepage": "about:blank"
    }
    for key, value in prefs.items():
        options.set_preference(key, value)
    return webdriver.Firefox(options=options)


def process_tree(root_pid: int) -> set[int]:
    # В некоторых контейнерах /proc/<pid>/task/<pid>/children пуст даже при
    # живых потомках, поэтому восстанавливаем дерево через обычный PPid.
    parents: dict[int, int] = {}
    try:
        entries = list(Path("/proc").iterdir())
    except OSError:
        return {root_pid}
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
            ppid_line = next(line for line in status.splitlines() if line.startswith("PPid:"))
            parents[int(entry.name)] = int(ppid_line.split()[1])
        except (OSError, StopIteration, ValueError):
            continue
    found = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, ppid in parents.items():
            if ppid in found and pid not in found:
                found.add(pid)
                changed = True
    return found


def tree_rss_kib(root_pid: int) -> int | None:
    if not Path("/proc").exists():
        return None
    total = 0
    seen = False
    for pid in process_tree(root_pid):
        try:
            status = Path(f"/proc/{pid}/status").read_text()
        except OSError:
            continue
        for line in status.splitlines():
            if line.startswith("VmRSS:"):
                total += int(line.split()[1])
                seen = True
                break
    return total if seen else None


class RssSampler:
    def __init__(self, root_pid: int) -> None:
        self.root_pid = root_pid
        self.stop_event = threading.Event()
        self.samples: list[int] = []
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self) -> None:
        while not self.stop_event.is_set():
            value = tree_rss_kib(self.root_pid)
            if value is not None:
                self.samples.append(value)
            self.stop_event.wait(0.1)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args) -> None:
        self.stop_event.set()
        self.thread.join(timeout=3)


def expected_crc32(byte_count: int, chunk_bytes: int) -> str:
    crc = 0
    written = 0
    index = 0
    while written < byte_count:
        length = min(chunk_bytes, byte_count - written)
        shift = (index * 17) & 0xff
        pattern = BASE_PATTERN[shift:] + BASE_PATTERN[:shift]
        chunk = (pattern * ((length + 255) // 256))[:length]
        crc = zlib.crc32(chunk, crc)
        written += length
        index += 1
    return f"{crc:08x}"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args) -> None:
        return


def host_info() -> dict:
    cpu = ""
    mem_kib = None
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.lower().startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                mem_kib = int(line.split()[1])
                break
    except OSError:
        pass
    return {
        "platform": platform.platform(), "python": platform.python_version(),
        "cpu": cpu, "logicalCpuCount": os.cpu_count(), "memoryKiB": mem_kib
    }


def run_one(name: str, mode: str, origin: str, byte_count: int, chunk_bytes: int,
            expected_crc: str, timeout: int) -> dict:
    record = {"browser": name, "mode": mode, "status": "failed"}
    driver = None
    sampler = None
    baseline = None
    try:
        log(f"{name}/{mode}: свежий браузер, {byte_count // MIB} МиБ")
        driver = make_driver(name)
        record["version"] = driver.capabilities.get("browserVersion")
        driver.get(origin + "/index.html")
        capabilities = driver.execute_script("""
          return {secure: isSecureContext, worker: typeof Worker === 'function',
                  opfsOnMain: !!(navigator.storage && navigator.storage.getDirectory)};
        """)
        record["pageCapabilities"] = capabilities
        if not capabilities["secure"] or not capabilities["worker"]:
            raise AssertionError(f"Нужен secure context и Worker: {capabilities}")

        root_pid = driver.service.process.pid
        baseline = tree_rss_kib(root_pid)
        sampler = RssSampler(root_pid)
        with sampler:
            started = driver.execute_script(
                "return window.startBenchmark(arguments[0], arguments[1], arguments[2])",
                mode, byte_count, chunk_bytes)
            if not started:
                raise AssertionError("Предыдущий сценарий ещё выполняется")
            deadline = time.monotonic() + timeout
            while True:
                state = driver.execute_script("return window.benchState")
                if state.get("status") in ("done", "error"):
                    break
                if time.monotonic() > deadline:
                    raise TimeoutError(f"Бенчмарк не завершился за {timeout} с: {state}")
                time.sleep(0.2)
        if state.get("status") != "done":
            raise AssertionError(state.get("error", "worker failed") + "\n" + state.get("stack", ""))
        result = state["result"]
        if mode == "opfs":
            cleanup = driver.execute_async_script("""
              const done = arguments[arguments.length - 1];
              setTimeout(async () => {
                try {
                  const root = await navigator.storage.getDirectory();
                  let exists = true;
                  try { await root.getFileHandle('rutube-opfs-benchmark.bin'); }
                  catch (error) { exists = false; }
                  const estimate = await navigator.storage.estimate();
                  done({exists, usage: estimate.usage || 0, quota: estimate.quota || 0});
                } catch (error) { done({error: String(error)}); }
              }, 500);
            """)
            record["opfsCleanupAfter500ms"] = cleanup
            if cleanup.get("error") or cleanup.get("exists") is not False:
                raise AssertionError(f"OPFS-файл не удалён: {cleanup}")
        if result["size"] != byte_count or result["verifiedBytes"] != byte_count:
            raise AssertionError(f"Размер не совпал: {result}")
        if result["crc32"] != expected_crc:
            raise AssertionError(f"CRC32 {result['crc32']} != {expected_crc}")
        record["result"] = result
        record["status"] = "passed"
    except Exception as exc:
        record["error"] = str(exc)
        if driver is not None:
            try:
                driver.save_screenshot(str(OUT / f"{name}-{mode}-failure.png"))
            except Exception:
                pass
    finally:
        if sampler is not None:
            peak = max(sampler.samples) if sampler.samples else baseline
            record["processMemory"] = {
                "method": "Linux /proc VmRSS, сумма дерева WebDriver и браузерных процессов; не чистый размер данных",
                "baselineKiB": baseline, "peakKiB": peak,
                "peakDeltaKiB": peak - baseline if peak is not None and baseline is not None else None,
                "samples": len(sampler.samples)
            }
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass
    if record["status"] == "passed":
        memory = record["processMemory"].get("peakDeltaKiB")
        memory_text = "n/a" if memory is None else f"{memory / 1024:.1f} МиБ"
        log(f"{name}/{mode}: OK, total {record['result']['timingMs']['total']:.0f} мс, пик ΔRSS {memory_text}")
    else:
        log(f"{name}/{mode}: FAIL — {record.get('error')}")
    return record


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=("chromium", "firefox", "all"), default="all")
    parser.add_argument("--size-mib", type=int, default=64)
    parser.add_argument("--chunk-kib", type=int, default=1024)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if not 1 <= args.size_mib <= 2048:
        parser.error("--size-mib: 1…2048")
    if not 1 <= args.chunk_kib <= 16384:
        parser.error("--chunk-kib: 1…16384")
    byte_count, chunk_bytes = args.size_mib * MIB, args.chunk_kib * 1024

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    expected_crc = expected_crc32(byte_count, chunk_bytes)
    handler = functools.partial(QuietHandler, directory=str(ROOT / "tests" / "opfs"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    names = ["chromium", "firefox"] if args.browser == "all" else [args.browser]
    runs = []
    try:
        # Небольшая пауза после HTTP-сервера не нужна; проверяем его до запуска браузеров.
        with urllib.request.urlopen(origin + "/index.html", timeout=5) as response:
            if response.status != 200:
                raise RuntimeError("Локальный стенд не отвечает")
        for name in names:
            for mode in ("blob", "opfs"):
                runs.append(run_one(name, mode, origin, byte_count, chunk_bytes, expected_crc, args.timeout))
    finally:
        server.shutdown()
        server.server_close()

    report = {
        "schemaVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "requestedBytes": byte_count, "chunkBytes": chunk_bytes, "expectedCrc32": expected_crc,
        "host": host_info(), "runs": runs,
        "interpretation": [
            "Каждый режим запускался в свежем браузерном процессе.",
            "peakDeltaKiB — пик суммарного RSS дерева процессов относительно страницы до запуска, не точный размер данных.",
            "Нельзя сравнивать абсолютный RSS разных браузеров или переносить один замер на файлы 2 ГиБ без отдельного прогона."
        ]
    }
    report_path = OUT / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"Отчёт: {report_path}")
    if any(run["status"] != "passed" for run in runs):
        raise SystemExit(1)
    log("Все режимы прошли; размер и CRC32 совпали")


if __name__ == "__main__":
    main()
