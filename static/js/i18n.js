/**
 * i18n — lightweight internationalization module for Odysseus
 *
 * Dual-strategy translation:
 *   1. data-i18n attributes (explicit) — elements tagged with
 *      data-i18n="nav.chat" get textContent replaced via dot-path lookup.
 *      Also supports data-i18n-placeholder, data-i18n-title, data-i18n-aria.
 *   2. Dynamic text mapping (implicit fallback) — builds a flat
 *      enValue → targetValue map by flattening both en.json and the
 *      target locale JSON by key, then walks DOM text nodes in leaf
 *      selectors and does exact + greedy substring replacement.
 *      This catches hardcoded English strings not tagged with data-i18n.
 *
 * Adding a new language:
 *   1. Create static/locales/xx.json with the same key structure as en.json
 *   2. Add an <option> to the language selector in index.html
 *
 * Persistence: localStorage('odysseus-lang') + optional /api/prefs/language
 */

const I18N = {
  currentLang: localStorage.getItem('odysseus-lang') || 'en',
  translations: {},
  enTranslations: {},
  _loaded: false,
  _callbacks: [],
  _textMap: null,
  _origTexts: [],

  async init() {
    // Try sync preloaded translations (inline script in <head>)
    if (window._i18n && window._i18n.t && Object.keys(window._i18n.t).length > 0) {
      this.translations = window._i18n.t;
      this.currentLang = window._i18n.lang;
    } else {
      await this.loadTranslations(this.currentLang);
    }

    // Always load English as the mapping source
    await this.loadEnTranslations();

    this._loaded = true;
    this._textMap = this._buildTextMap();
    this.apply();
    this._callbacks.forEach(cb => cb(this.translations));
    this._callbacks = [];
    this._observeDOM();
    return this.translations;
  },

  ready(callback) {
    if (this._loaded) {
      callback && callback(this.translations);
      return Promise.resolve(this.translations);
    }
    return new Promise(resolve => {
      this._callbacks.push((t) => { callback && callback(t); resolve(t); });
    });
  },

  async loadTranslations(lang) {
    try {
      const response = await fetch(`/static/locales/${lang}.json?v=${Date.now()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.translations = await response.json();
      this.currentLang = lang;
      console.log(`[i18n] Loaded: ${lang}`);
    } catch (e) {
      console.warn('[i18n] Failed to load translations:', e);
      this.translations = {};
    }
  },

  async loadEnTranslations() {
    if (Object.keys(this.enTranslations).length > 0) return;
    try {
      const response = await fetch(`/static/locales/en.json?v=${Date.now()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.enTranslations = await response.json();
      console.log('[i18n] Loaded: en (base)');
    } catch (e) {
      console.warn('[i18n] Failed to load en.json:', e);
      this.enTranslations = {};
    }
  },

  t(key, fallback) {
    const keys = key.split('.');
    let value = this.translations;
    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) break;
    }
    return value || fallback || key;
  },

  tf(key, params = {}, fallback) {
    let text = this.t(key, fallback);
    Object.keys(params).forEach(k => {
      text = text.replace(new RegExp(`{${k}}`, 'g'), params[k]);
    });
    return text;
  },

  async setLang(lang) {
    if (lang === this.currentLang) return;

    // Restore original text before switching
    this._restoreOriginals();

    await this.loadTranslations(lang);
    this.currentLang = lang;
    localStorage.setItem('odysseus-lang', lang);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;

    // Persist to user prefs (fire-and-forget, non-blocking)
    try {
      fetch('/api/prefs/language', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: lang })
      }).catch(() => {});
    } catch (e) { /* prefs API optional */ }

    // Rebuild text map and re-apply
    this._textMap = this._buildTextMap();
    this._origTexts = [];
    this.apply();

    window.dispatchEvent(new CustomEvent('i18n:languageChanged', {
      detail: { lang, translations: this.translations }
    }));
    console.log(`[i18n] Switched to: ${lang}`);
  },

  /* ═══ Build text map: en.json value → target language value ═══ */
  _buildTextMap() {
    if (this.currentLang === 'en') return {};
    const map = {};
    const enFlat = {};
    const targetFlat = {};

    const flatten = (obj, prefix, target) => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') {
          target[key] = v;
        } else if (typeof v === 'object' && v !== null) {
          flatten(v, key, target);
        }
      }
    };

    flatten(this.enTranslations, '', enFlat);
    flatten(this.translations, '', targetFlat);

    // Match by key: en value → target value
    for (const key of Object.keys(enFlat)) {
      if (targetFlat[key] && enFlat[key] !== targetFlat[key]) {
        map[enFlat[key]] = targetFlat[key];
      }
    }

    console.log(`[i18n] Text map built: ${Object.keys(map).length} entries`);
    return map;
  },

  apply(root = document) {
    // 1. data-i18n attribute translation (always active)
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      const text = this.t(key);
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.placeholder) el.placeholder = text;
      } else {
        el.textContent = text;
      }
    });

    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = this.t(el.dataset.i18nPlaceholder);
    });

    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = this.t(el.dataset.i18nTitle);
    });

    root.querySelectorAll('[data-i18n-aria]').forEach(el => {
      el.setAttribute('aria-label', this.t(el.dataset.i18nAria));
    });

    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = this.t(el.dataset.i18nHtml);
    });

    // 2. Dynamic text mapping (implicit fallback for untagged strings)
    if (this.currentLang !== 'en' && this._textMap && Object.keys(this._textMap).length > 0) {
      this._applyTextMap(root);
    }
  },

  /* Scan DOM text nodes and replace using text map */
  _applyTextMap(root) {
    const map = this._textMap;
    if (!map) return;

    const leafSelectors =
      '.settings-label, .settings-nav-item, .admin-toggle-sub, .vis-label, ' +
      '.section-title-label, .list-item, .memory-toolbar-btn, .admin-tab, ' +
      '.section-header-btn, .theme-io-btn, .color-row label, ' +
      'h2 > span, h4 > span, .vis-hint, .settings-fallback-add, ' +
      'button, label, option, .grow';

    // 1. Leaf-level text node replacement (precise match)
    root.querySelectorAll(leafSelectors).forEach(el => {
      if (el.dataset.i18n || el.dataset.i18nHtml) return;
      this._translateTextNodes(el, map);
    });

    // 2. Container-level innerHTML replacement (handles HTML children like <code>)
    const htmlContainers = root.querySelectorAll('.admin-toggle-sub, .vis-label');
    htmlContainers.forEach(el => {
      if (el.dataset.i18n || el.dataset.i18nHtml) return;
      if (el._i18nHtmlSaved) return;
      const html = el.innerHTML;
      this._tryInnerHtmlMap(el, html, map);
    });

    // 3. h2/h4 direct text (no span wrapper)
    root.querySelectorAll('h2, h4').forEach(el => {
      if (el.dataset.i18n || el.dataset.i18nHtml) return;
      if (el.querySelector('[data-i18n]')) return;
      this._translateTextNodes(el, map);
    });
  },

  /* Translate text nodes within an element */
  _translateTextNodes(el, map) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    textNodes.forEach(node => {
      if (node._i18nSaved) return;
      const text = node.textContent.trim();
      if (!text) return;

      // Exact match
      if (map[text]) {
        this._origTexts.push({ node, original: node.textContent });
        node._i18nSaved = true;
        node.textContent = node.textContent.replace(text, map[text]);
        return;
      }

      // Greedy match: find longest key contained in text
      for (const [enText, targetText] of Object.entries(map)) {
        if (enText.length < 4) continue;
        if (text.includes(enText)) {
          this._origTexts.push({ node, original: node.textContent });
          node._i18nSaved = true;
          node.textContent = node.textContent.replace(enText, targetText);
          break;
        }
      }
    });
  },

  /* Try innerHTML-level replacement (for elements with HTML children) */
  _tryInnerHtmlMap(el, html, map) {
    let newHtml = html;
    let changed = false;

    for (const [enText, targetText] of Object.entries(map)) {
      if (enText.length < 4) continue;
      if (newHtml.includes(enText)) {
        newHtml = newHtml.replace(enText, targetText);
        changed = true;
      }
    }

    if (changed) {
      el._i18nHtmlSaved = true;
      this._origTexts.push({ el, originalHtml: html, type: 'html' });
      el.innerHTML = newHtml;
    }
    return changed;
  },

  /* Restore original text (before language switch) */
  _restoreOriginals() {
    this._origTexts.forEach(item => {
      if (item.type === 'html' && item.el) {
        item.el.innerHTML = item.originalHtml;
        delete item.el._i18nHtmlSaved;
      } else if (item.node && item.node.parentNode) {
        item.node.textContent = item.original;
        delete item.node._i18nSaved;
      }
    });
    this._origTexts = [];
  },

  /* Observe DOM for dynamically added content */
  _observeDOM() {
    if (typeof MutationObserver === 'undefined') return;

    const observer = new MutationObserver((mutations) => {
      let shouldApply = false;

      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.hasAttribute &&
              (node.hasAttribute('data-i18n') ||
               node.hasAttribute('data-i18n-placeholder') ||
               node.hasAttribute('data-i18n-title') ||
               node.hasAttribute('data-i18n-aria') ||
               node.hasAttribute('data-i18n-html') ||
               node.querySelector('[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria], [data-i18n-html]'))) {
              shouldApply = true;
            }
            if (node.matches && node.matches(
              '#settings-panel, .admin-card, h2, h4, .settings-label, .admin-toggle-sub, ' +
              '.vis-label, .section-title, .list-item, button, label, option'
            )) {
              shouldApply = true;
            }
            if (node.querySelector) {
              const sub = node.querySelector(
                '#settings-panel, .admin-card, h2, h4, .settings-label, .admin-toggle-sub, button, label'
              );
              if (sub) shouldApply = true;
            }
          }
        });
      });

      if (shouldApply) this.apply();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }
};

// Global shortcuts
window.t = (key, fallback) => {
  if (window._i18n && window._i18n.t) {
    const keys = key.split('.');
    let val = window._i18n.t;
    for (const k of keys) { val = val?.[k]; if (val === undefined) break; }
    if (val !== undefined) return val;
  }
  return I18N.t(key, fallback);
};
window.tf = (key, params, fallback) => I18N.tf(key, params, fallback);
window.I18N = I18N;

// Auto-init on module load
I18N.init();

export default I18N;