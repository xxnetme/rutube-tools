'use strict';
/* global window, document, Worker */

function renderState() {
  const output = document.querySelector('#output');
  if (output) output.textContent = JSON.stringify(window.benchState, null, 2);
}

window.benchState = { status: 'idle' };
window.startBenchmark = function (mode, bytes, chunkBytes) {
  if (window.benchState.status === 'running') return false;
  window.benchState = { status: 'running', mode, bytes, chunkBytes };
  renderState();
  const worker = new Worker('./worker.js');
  worker.onmessage = (event) => {
    if (event.data.ok) window.benchState = { status: 'done', result: event.data.result };
    else window.benchState = { status: 'error', error: event.data.error, stack: event.data.stack };
    worker.terminate();
    renderState();
  };
  worker.onerror = (event) => {
    window.benchState = { status: 'error', error: event.message || 'worker error' };
    worker.terminate();
    renderState();
  };
  worker.postMessage({ mode, bytes, chunkBytes });
  return true;
};

for (const mode of ['blob', 'opfs']) {
  document.querySelector(`#${mode}`).addEventListener('click', () => {
    const size = Number(document.querySelector('#size').value);
    window.startBenchmark(mode, Math.round(size * 1024 * 1024), 1024 * 1024);
  });
}
