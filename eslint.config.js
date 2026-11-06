'use strict';
/* Линтер ловит опечатки, необъявленные переменные, мёртвый код и опасные DOM-приёмы. */
const noUnsanitized = require('eslint-plugin-no-unsanitized');
const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', localStorage: 'readonly',
  fetch: 'readonly', URL: 'readonly', Blob: 'readonly', AbortController: 'readonly', TextEncoder: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  console: 'readonly', globalThis: 'readonly', self: 'readonly', importScripts: 'readonly',
  chrome: 'readonly', browser: 'readonly', getComputedStyle: 'readonly', requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly', MutationObserver: 'readonly', HTMLElement: 'readonly', Event: 'readonly',
  KeyboardEvent: 'readonly', MouseEvent: 'readonly', CSS: 'readonly', Image: 'readonly', FileReader: 'readonly',
  Buffer: 'readonly', module: 'writable', require: 'readonly', muxjs: 'readonly', RTLib: 'readonly', RTAudio: 'readonly',
  RTI18n: 'readonly', RTNetwork: 'readonly', Promise: 'readonly', Map: 'readonly', Set: 'readonly', Uint8Array: 'readonly',
  Intl: 'readonly', Date: 'readonly', alert: 'readonly', prompt: 'readonly', screen: 'readonly'
};

module.exports = [
  { ignores: ['src/lib/mux-mp4.min.js', 'build/**', 'release/**', 'docs/**', 'node_modules/**'] },
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: browserGlobals },
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'eqeqeq': ['warn', 'smart'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error'
    }
  },
  {
    files: ['tests/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022, sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly', process: 'readonly', Buffer: 'readonly',
        globalThis: 'readonly', setTimeout: 'readonly', console: 'readonly', fetch: 'readonly', AbortController: 'readonly',
        URL: 'readonly', Headers: 'readonly', Blob: 'readonly' }
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none' }] }
  }
];
