import en from './i18n/en.js';
import zhTW from './i18n/zh-TW.js';

const catalogs = { 'zh-TW': zhTW, en };
const preference = 'oep.locale';
const bindings = new WeakMap();
const attributes = ['placeholder', 'aria-label', 'aria-description', 'title', 'alt'];
let locale = localStorage.getItem(preference) === 'en' ? 'en' : 'zh-TW';

export function getLocale() {
  return locale;
}

export function hasMessage(key) {
  return Object.hasOwn(catalogs[locale], key);
}

export function t(key, params = {}) {
  return catalogs[locale][key].replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? resolveText(params[name]) : match);
}

// A callback keeps a message and its formatted values current while its node exists.
export function message(key, params) {
  return () => t(key, params);
}

export function resolveText(value) {
  return (typeof value === 'function' ? value() : value) ?? '';
}

export function joinText(parts, separator = ' · ') {
  return () => parts.map(resolveText).filter(value => value !== '').join(separator);
}

export function textNode(value) {
  const node = document.createTextNode(resolveText(value));
  if (typeof value === 'function') bindings.set(node, new Map([['data', () => { node.data = value(); }]]));
  return node;
}

export function setText(element, value) {
  element.replaceChildren(textNode(value));
}

export function setAttribute(element, name, value) {
  element.setAttribute(name, resolveText(value));
  if (typeof value === 'function') {
    const updates = bindings.get(element) ?? new Map();
    updates.set(name, () => element.setAttribute(name, value()));
    bindings.set(element, updates);
  } else {
    bindings.get(element)?.delete(name);
  }
}

export function optionText(label, value) {
  const option = new Option('', value);
  setText(option, label);
  return option;
}

export function formatDate(value, options, timestamp = true) {
  return () => new Intl.DateTimeFormat(locale, options ?? {
    dateStyle: 'short',
    ...(timestamp ? { timeStyle: 'medium' } : {}),
  }).format(new Date(value));
}

export function formatList(values) {
  return () => values.map(resolveText).join(t('ui.list-separator'));
}

export function formatNumber(value, options) {
  return () => new Intl.NumberFormat(locale, options).format(value);
}

export class LocalizedError extends Error {
  constructor(text, options) {
    super(resolveText(text), options);
    this.localizedText = text;
  }
}

export function initializeLocale() {
  document.documentElement.lang = locale;
  for (const element of document.querySelectorAll('[data-i18n]')) setText(element, message(element.dataset.i18n));
  for (const name of attributes) {
    for (const element of document.querySelectorAll('[data-i18n-' + name + ']')) {
      setAttribute(element, name, message(element.getAttribute('data-i18n-' + name)));
    }
  }
}

export function setLocale(value) {
  if (value === locale || !Object.hasOwn(catalogs, value)) return;
  localStorage.setItem(preference, value);
  document.documentElement.lang = locale = value;
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    for (const update of bindings.get(node)?.values() ?? []) update();
  }
}
