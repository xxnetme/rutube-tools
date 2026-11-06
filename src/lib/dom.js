/* RuTube Tools — маленький DOM-конструктор. Строки становятся только текстом, не HTML. */
'use strict';
(function (global) {
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var PROPS = { checked: true, disabled: true, hidden: true, selected: true, value: true };

  function append(parent) {
    var children = Array.prototype.slice.call(arguments, 1);
    children.forEach(function add(child) {
      if (child == null || child === false) return;
      if (Array.isArray(child)) { child.forEach(add); return; }
      if (child && typeof child.nodeType === 'number') parent.appendChild(child);
      else parent.appendChild(parent.ownerDocument.createTextNode(String(child)));
    });
    return parent;
  }

  function applyAttrs(el, attrs) {
    Object.keys(attrs || {}).forEach(function (name) {
      var value = attrs[name];
      if (name === 'class' || name === 'className') { el.className = value == null ? '' : String(value); return; }
      if (name === 'text') { el.textContent = value == null ? '' : String(value); return; }
      if (name === 'style' && value && typeof value === 'object') {
        Object.keys(value).forEach(function (key) { el.style.setProperty(key, String(value[key])); });
        return;
      }
      if (name === 'dataset' && value && typeof value === 'object') {
        Object.keys(value).forEach(function (key) { el.dataset[key] = String(value[key]); });
        return;
      }
      if (name === 'on' && value && typeof value === 'object') {
        Object.keys(value).forEach(function (key) {
          if (typeof value[key] === 'function') el.addEventListener(key, value[key]);
        });
        return;
      }
      if (PROPS[name]) { el[name] = value; return; }
      if (value == null || value === false) return;
      if (name === 'for') { el.htmlFor = String(value); return; }
      if (value === true) { el.setAttribute(name, ''); return; }
      el.setAttribute(name, String(value));
    });
  }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    append.apply(null, [el].concat(Array.prototype.slice.call(arguments, 2)));
    applyAttrs(el, attrs);
    return el;
  }

  function svg(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (name) {
      if (attrs[name] != null) el.setAttribute(name, String(attrs[name]));
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function set(parent) {
    parent.replaceChildren();
    return append.apply(null, [parent].concat(Array.prototype.slice.call(arguments, 1)));
  }

  global.RTDom = { h: h, svg: svg, set: set, append: append };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.RTDom;
})(typeof globalThis !== 'undefined' ? globalThis : this);
