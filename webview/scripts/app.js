/**
 * OpenRouter Maestro — Main Application
 * Orchestrates UI rendering, user interaction, tabs, and extension communication.
 * Targets: Copilot Chat (native provider), Claude Code, OpenAI Codex.
 *
 * Visual language "Glass & Glow": the tab bar is an agent dock whose tiles show
 * live status, model cards carry a joined agent toggle group, and every icon is
 * inline SVG (the webview CSP forbids images).
 */
(function() {
  'use strict';

  // ===== STATE =====
  let allModels = [];
  let selectedModelIds = new Set();
  let selectedModelsData = [];
  let activeCopilotModels = [];
  let integrationStatuses = []; // Claude Code / Codex integration state
  let agentRosters = {};        // target -> saved model list (not necessarily active)
  let pendingReload = {};       // target -> config changed, agent not restarted yet
  let hasApiKey = false;
  let apiKeyKnown = false;
  let isLoading = false;
  let activeTab = 'browse';     // 'browse' | 'copilot' | 'claude' | 'codex'
  let searchDebounceTimer = null;
  let lastListKey = '';         // which cards are listed — animate only when it changes
  const openDescriptions = new Set();
  let providerNames = {};       // slug -> display name, derived from model names
  let meterRange = null;        // catalog min/max for the card mini meters (log scale)
  const ringShown = {};         // target -> { key, at } of the ring last drawn while visible
  const RING_MS = 900;          // draw-in duration (matches .ring.animate in cards.css)
  let pendingToast = null;      // info toast waiting for a visible error toast to go
  let toastTimer = null;
  let toastEl = null;
  const dockCache = {};         // tile -> last rendered state key (skip identical re-renders)

  // ===== ICONS (inline SVG, 24x24 stroke set) =====
  const ICON = {
    search:   '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    key:      '<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 8.6-8.6M16.5 6.5l2.5 2.5M14.5 8.5l2 2"/>',
    refresh:  '<path d="M20 11a8 8 0 0 0-14.3-4.7L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.7L20 16"/><path d="M20 20v-4h-4"/>',
    x:        '<path d="M17 7 7 17M7 7l10 10"/>',
    check:    '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    plus:     '<path d="M12 5.5v13M5.5 12h13"/>',
    dot:      '<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>',
    eye:      '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    wrench:   '<path d="M14.5 6.5a4.5 4.5 0 0 0 5.6 5.6L13 19.2a2.5 2.5 0 0 1-3.5-3.5l7.1-7.1"/><path d="M14.5 6.5 17 4a4.5 4.5 0 0 1 3 3l-2.5 2.5"/><circle cx="6.3" cy="17.7" r=".6" fill="currentColor"/>',
    bulb:     '<path d="M9 18.5h6M10 21.5h4"/><path d="M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.5.4.8 1 .8 1.7v.5h6V16c0-.7.3-1.3.8-1.7A6.5 6.5 0 0 0 12 2.5z"/>',
    tag:      '<path d="M20.2 13.3 13.3 20.2a1.8 1.8 0 0 1-2.6 0L3.5 13V3.5H13l7.2 7.2a1.8 1.8 0 0 1 0 2.6z"/><circle cx="8.2" cy="8.2" r="1.4"/>',
    image:    '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="9" cy="9" r="1.8"/><path d="m20.5 15-5-5-11 11"/>',
    layers:   '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
    sort:     '<path d="M4 6.5h10M4 12h7M4 17.5h4"/><path d="M18 5v14M15 16l3 3 3-3"/>',
    chevDown: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
    chevRight:'<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
    trash:    '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7"/><path d="M10.2 11v5M13.8 11v5"/>',
    file:     '<path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13.5 3.5V9H19"/>',
    warn:     '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.2" r=".5" fill="currentColor"/>',
    info:     '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".5" fill="currentColor"/>',
    reload:   '<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5"/><path d="M20 4v4.5h-4.5"/>',
    undo:     '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
    play:     '<path d="M8 5.5v13l10.5-6.5z"/>',
    compass:  '<circle cx="12" cy="12" r="8.5"/><path d="m15.6 8.4-2.2 5-5 2.2 2.2-5z"/>',
    clock:    '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    slash:    '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
    cloud:    '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5a4.5 4.5 0 0 1 0 9z"/><path d="M12 11.5v5M9.8 14.5l2.2 2.2 2.2-2.2"/>',
    sparkle:  '<path d="M12 3.5 13.8 10.2 20.5 12 13.8 13.8 12 20.5 10.2 13.8 3.5 12 10.2 10.2z"/>',
    // Agent glyphs — simple generic marks, not vendor logos.
    copilot:  '<path d="M3.5 13.5a8.5 8.5 0 0 1 17 0V15a4 4 0 0 1-4 4h-9a4 4 0 0 1-4-4z"/><circle cx="8.8" cy="13.2" r="2.3"/><circle cx="15.2" cy="13.2" r="2.3"/><path d="M11.1 13.2h1.8"/>',
    claude:   '<path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6 6 18"/>',
    codex:    '<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="m8 9.5 2.8 2.5L8 14.5M13 15h3.5"/>',
  };

  function icon(name, cls) {
    return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[name] || ''}</svg>`;
  }

  // ===== DOM REFS =====
  const $ = (sel) => document.querySelector(sel);

  const dom = {
    app:               $('#app'),
    views:             $('#views'),
    tabBrowse:         $('#tab-browse'),
    tabCopilot:        $('#tab-copilot'),
    tabClaude:         $('#tab-claude'),
    tabCodex:          $('#tab-codex'),
    tabContentBrowse:  $('#tab-content-browse'),
    tabContentCopilot: $('#tab-content-copilot'),
    tabContentClaude:  $('#tab-content-claude'),
    tabContentCodex:   $('#tab-content-codex'),
    copilotCount:      $('#copilot-count'),
    claudeCount:       $('#claude-count'),
    codexCount:        $('#codex-count'),
    browseSub:         $('#browse-sub'),
    copilotSub:        $('#copilot-sub'),
    claudeSub:         $('#claude-sub'),
    codexSub:          $('#codex-sub'),
    copilotHero:       $('#copilot-hero'),
    copilotModelsList: $('#copilot-models-list'),
    claudeAgentCard:   $('#claude-agent-card'),
    codexAgentCard:    $('#codex-agent-card'),
    searchInput:      $('#search-input'),
    searchClear:      $('#search-clear'),
    filterVision:     $('#filter-vision'),
    filterTools:      $('#filter-tools'),
    filterFree:       $('#filter-free'),
    filterReasoning:  $('#filter-reasoning'),
    sortSelect:       $('#sort-select'),
    providerBtn:      $('#provider-filter-btn'),
    providerLabel:    $('#provider-filter-label'),
    providerMenu:     $('#provider-menu'),
    statsCount:       $('#stats-count'),
    statsFiltered:    $('#stats-filtered'),
    modelList:        $('#model-list'),
    syncBtn:          $('#sync-btn'),
    apiKeyBtn:        $('#apikey-btn'),
    apiKeyBanner:     $('#apikey-banner'),
    apiKeyBannerBtn:  $('#apikey-banner-btn'),
    loadingOverlay:   $('#loading-overlay'),
    toastContainer:   $('#toast-container'),
  };

  const TABS = ['browse', 'copilot', 'claude', 'codex'];
  const TAB_TARGET = { claude: 'claude-code', codex: 'codex' };

  // ===== INIT =====
  function init() {
    hydrateIcons(document);
    syncScrollbarGutter();
    if (window.ResizeObserver) new ResizeObserver(syncScrollbarGutter).observe(dom.views);
    else window.addEventListener('resize', syncScrollbarGutter);
    bindEvents();
    renderModels();
    renderCopilotModels();
    renderAgentDetails();
    renderDock();
    vscodeApi.onMessage(handleExtensionMessage);
    vscodeApi.postMessage({ type: 'ready' });
  }

  /**
   * The scroll area reserves a stable scrollbar gutter; the header and dock
   * sit outside it, so they get the same width as right padding (--sbw) and
   * every right edge lines up. Overlay scrollbars measure 0.
   */
  function syncScrollbarGutter() {
    const sbw = Math.max(0, dom.views.offsetWidth - dom.views.clientWidth);
    dom.app.style.setProperty('--sbw', sbw + 'px');
  }

  /** Fill every static `<span data-icon="name">` with its SVG. */
  function hydrateIcons(root) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      if (!el.firstElementChild) el.innerHTML = icon(el.dataset.icon);
    });
  }

  // ===== EVENT BINDING =====
  function bindEvents() {
    // Tabs (agent dock) — click + roving arrow-key navigation.
    const tabBtns = { browse: dom.tabBrowse, copilot: dom.tabCopilot, claude: dom.tabClaude, codex: dom.tabCodex };
    for (const [name, btn] of Object.entries(tabBtns)) {
      btn.addEventListener('click', () => switchTab(name));
      btn.addEventListener('keydown', (e) => {
        const i = TABS.indexOf(name);
        let next = null;
        if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
        if (e.key === 'ArrowLeft') next = TABS[(i + TABS.length - 1) % TABS.length];
        if (e.key === 'Home') next = TABS[0];
        if (e.key === 'End') next = TABS[TABS.length - 1];
        if (next) {
          e.preventDefault();
          switchTab(next);
          tabBtns[next].focus();
        }
      });
    }

    // Search
    dom.searchInput.addEventListener('input', () => {
      const val = dom.searchInput.value;
      dom.searchClear.classList.toggle('visible', val.length > 0);
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        Filters.set('search', val);
        renderModels();
      }, 200);
    });
    dom.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dom.searchInput.value) {
        e.preventDefault();
        clearSearch();
      }
    });
    dom.searchClear.addEventListener('click', () => {
      clearSearch();
      dom.searchInput.focus();
    });

    // "/" focuses search from anywhere outside a text field.
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      if (activeTab !== 'browse') switchTab('browse');
      dom.searchInput.focus();
      dom.searchInput.select();
    });

    // Filter chips
    const chip = (el, key) => el && el.addEventListener('click', () => {
      Filters.toggle(key);
      const on = el.classList.toggle('active');
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      renderModels();
    });
    chip(dom.filterVision, 'vision');
    chip(dom.filterTools, 'toolCalling');
    chip(dom.filterFree, 'free');
    chip(dom.filterReasoning, 'reasoning');

    // Sort
    dom.sortSelect.addEventListener('change', () => {
      Filters.set('sortBy', dom.sortSelect.value);
      renderModels();
    });

    // Provider dropdown
    dom.providerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setProviderMenu(!dom.providerMenu.classList.contains('open'), true);
    });
    dom.providerBtn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setProviderMenu(true, true);
      }
    });
    dom.providerMenu.addEventListener('click', (e) => e.stopPropagation());
    dom.providerMenu.addEventListener('keydown', (e) => {
      const items = [...dom.providerMenu.querySelectorAll('.provider-option')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
      if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      if (e.key === 'Escape' || e.key === 'Tab') {
        if (e.key === 'Escape') e.preventDefault();
        setProviderMenu(false);
        if (e.key === 'Escape') dom.providerBtn.focus();
      }
    });
    document.addEventListener('click', () => setProviderMenu(false));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (dom.providerMenu.classList.contains('open')) {
        setProviderMenu(false);
        dom.providerBtn.focus();
        return;
      }
      if (toastEl) dismissToast();
    });

    // Toasts: click anywhere on the toast to dismiss it.
    dom.toastContainer.addEventListener('click', (e) => {
      if (e.target.closest('.toast')) dismissToast();
    });

    // Sync
    dom.syncBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'syncModels' });
    });

    // API Key buttons
    dom.apiKeyBtn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'setApiKey' });
    });
    if (dom.apiKeyBannerBtn) {
      dom.apiKeyBannerBtn.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'setApiKey' });
      });
    }

    // Model list — delegated (the list is re-rendered often).
    dom.modelList.addEventListener('click', (e) => {
      const target = e.target.closest('button');
      if (!target || !dom.modelList.contains(target)) return;

      if (target.classList.contains('target-btn')) {
        const modelId = target.dataset.modelId;
        const agent = target.dataset.target;
        if (agent === 'copilot') {
          vscodeApi.postMessage({ type: 'toggleCopilot', modelId });
          return;
        }
        // Claude Code / Codex keep a saved list, like Copilot. The card button
        // only adds/removes list membership; which entry is *active* is chosen
        // in the agent's own tab.
        vscodeApi.postMessage({
          type: isInRoster(agent, modelId) ? 'removeFromAgent' : 'addToAgent',
          target: agent,
          modelId,
        });
        return;
      }

      if (target.classList.contains('model-card-desc-toggle')) {
        const card = target.closest('.model-card');
        const id = card && card.dataset.modelId;
        const open = !card.classList.contains('desc-open');
        card.classList.toggle('desc-open', open);
        target.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) openDescriptions.add(id); else openDescriptions.delete(id);
        return;
      }

      if (target.dataset.action) runAction(target.dataset.action);
    });

    // Copilot list — delegated.
    dom.copilotModelsList.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.removeCopilot) {
        window.removeActiveModel(btn.dataset.removeCopilot);
        return;
      }
      if (btn.dataset.effort) {
        if (btn.getAttribute('aria-checked') === 'true') return;
        window.setReasoningEffort({ dataset: { modelId: btn.dataset.modelId }, value: btn.dataset.effort });
        // Optimistic: reflect the choice immediately; the host echoes the list.
        btn.parentElement.querySelectorAll('[data-effort]').forEach((b) => {
          b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
          b.tabIndex = b === btn ? 0 : -1;
        });
        return;
      }
      if (btn.dataset.action) runAction(btn.dataset.action);
    });
    dom.copilotModelsList.addEventListener('keydown', (e) => {
      const btn = e.target.closest && e.target.closest('[data-effort]');
      if (!btn) return;
      const all = [...btn.parentElement.querySelectorAll('[data-effort]')];
      const i = all.indexOf(btn);
      let next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = all[(i + 1) % all.length];
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = all[(i + all.length - 1) % all.length];
      if (e.key === 'Home') next = all[0];
      if (e.key === 'End') next = all[all.length - 1];
      if (!next) return;
      e.preventDefault();
      next.focus();
      if (next !== btn) next.click();
    });

    // Agent tabs — delegated.
    for (const [tab, container] of [['claude', dom.claudeAgentCard], ['codex', dom.codexAgentCard]]) {
      const target = TAB_TARGET[tab];
      container.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.hasAttribute('data-reload-window')) {
          vscodeApi.postMessage({ type: 'reloadWindow' });
          return;
        }
        if (btn.dataset.activate) {
          e.stopPropagation();
          vscodeApi.postMessage({ type: 'activateAgentModel', target, modelId: btn.dataset.activate });
          return;
        }
        if (btn.dataset.remove) {
          e.stopPropagation();
          vscodeApi.postMessage({ type: 'removeFromAgent', target, modelId: btn.dataset.remove });
          return;
        }
        if (btn.hasAttribute('data-agent-default-btn')) {
          vscodeApi.postMessage({ type: 'deactivateAgent', target });
          return;
        }
        if (btn.dataset.action) runAction(btn.dataset.action);
      });
    }
  }

  /** Small client-side actions used by empty-state buttons. */
  function runAction(action) {
    if (action === 'setApiKey') vscodeApi.postMessage({ type: 'setApiKey' });
    if (action === 'syncModels') vscodeApi.postMessage({ type: 'syncModels' });
    if (action === 'resetFilters') window.resetFilters();
    if (action === 'browse') { switchTab('browse'); dom.searchInput.focus(); }
  }

  function clearSearch() {
    dom.searchInput.value = '';
    dom.searchClear.classList.remove('visible');
    clearTimeout(searchDebounceTimer);
    Filters.set('search', '');
    renderModels();
  }

  function setProviderMenu(open, focusSelected) {
    const menu = dom.providerMenu;
    menu.classList.toggle('open', open);
    dom.providerBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) return;
    // Keep the popover inside the viewport with an 8px gutter on both sides.
    menu.style.right = '0px';
    const right = menu.getBoundingClientRect().right; // origin is top-right: unaffected by the pop-in scale
    const left = right - menu.offsetWidth;
    const W = document.documentElement.clientWidth;
    let shift = 0;
    if (right > W - 8) shift = right - (W - 8);
    if (left - shift < 8) shift = left - 8;
    if (shift) menu.style.right = `${shift}px`;
    if (focusSelected) {
      const sel = menu.querySelector('.provider-option.selected') || menu.querySelector('.provider-option');
      if (sel) {
        sel.focus({ preventScroll: true });
        sel.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function switchTab(tab) {
    activeTab = tab;
    const tabs = {
      browse:  { btn: dom.tabBrowse,  content: dom.tabContentBrowse },
      copilot: { btn: dom.tabCopilot, content: dom.tabContentCopilot },
      claude:  { btn: dom.tabClaude,  content: dom.tabContentClaude },
      codex:   { btn: dom.tabCodex,   content: dom.tabContentCodex },
    };
    for (const [name, t] of Object.entries(tabs)) {
      const on = name === tab;
      t.btn.classList.toggle('active', on);
      t.btn.setAttribute('aria-selected', on ? 'true' : 'false');
      t.btn.tabIndex = on ? 0 : -1;
      t.content.classList.toggle('active', on);
    }
    dom.app.dataset.tab = tab;
    if (dom.views) dom.views.scrollTop = 0;
    setProviderMenu(false);
    updateApiKeyUI();
    if (tab === 'copilot') renderCopilotModels();
    if (tab === 'claude' || tab === 'codex') {
      renderAgentDetails();
      vscodeApi.postMessage({ type: 'getAgentRosters' });
      vscodeApi.postMessage({ type: 'getIntegrationStatus' });
    }
  }

  // ===== EXTENSION MESSAGE HANDLER =====
  function handleExtensionMessage(msg) {
    switch (msg.type) {
      case 'modelsLoaded':
        allModels = msg.models;
        buildProviderNames();
        buildMeterRange();
        renderModels();
        renderProviderDropdown();
        renderCopilotModels();
        renderAgentDetails();
        updateStats(msg.total);
        renderDock();
        break;
      case 'selectedModelsUpdated':
        selectedModelsData = msg.models;
        selectedModelIds = new Set(msg.models.map(m => m.id));
        renderModels();
        break;
      case 'activeModelsUpdated':
        activeCopilotModels = msg.models;
        updateCounts();
        renderCopilotModels();
        renderModels();
        renderDock();
        break;
      case 'copilotToggled':
        showToast(msg.message, msg.enabled ? 'success' : 'info');
        break;
      case 'modelAdded':
      case 'modelRemoved':
        break;
      case 'appliedToCopilot':
        showToast(msg.message, msg.success ? 'success' : 'error');
        break;
      case 'integrationStatus':
        integrationStatuses = msg.statuses || [];
        updateCounts();
        renderAgentDetails();
        renderModels();
        break;
      case 'agentRostersUpdated':
        agentRosters = {};
        (msg.rosters || []).forEach(r => { agentRosters[r.target] = r.models || []; });
        updateCounts();
        renderAgentDetails();
        renderModels();
        break;
      case 'integrationApplied':
        showToast(msg.message, msg.success ? 'success' : 'error');
        // The config on disk changed, but a running Claude Code / Codex session
        // keeps the config it started with — surface that instead of letting
        // the user think the switch silently failed.
        if (msg.success && msg.target !== 'copilot') {
          pendingReload[msg.target] = true;
          renderAgentDetails();
          renderDock();
        }
        break;
      case 'error':
        showToast(msg.message, 'error');
        break;
      case 'loading':
        setLoading(msg.isLoading);
        break;
      case 'apiKeyStatus':
        hasApiKey = msg.hasKey;
        apiKeyKnown = true;
        updateApiKeyUI();
        renderModels();
        break;
      case 'syncComplete':
        if (msg.newModelsCount > 0) {
          showToast(`${msg.newModelsCount} new model(s) found!`, 'success');
        } else {
          showToast('Models synced, all up to date', 'info');
        }
        break;
    }
  }

  // ===== HELPERS: names, providers, numbers =====
  function buildProviderNames() {
    providerNames = {};
    for (const m of allModels) {
      if (providerNames[m.provider]) continue;
      const idx = (m.name || '').indexOf(': ');
      if (idx > 0 && idx < 32) providerNames[m.provider] = m.name.slice(0, idx);
    }
  }

  function providerName(slug) {
    if (!slug) return '';
    if (providerNames[slug]) return providerNames[slug];
    return slug.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  /** "Anthropic: Claude Sonnet 4.5" -> "Claude Sonnet 4.5" */
  function shortName(name) {
    if (!name) return '';
    const idx = name.indexOf(': ');
    return idx > 0 && idx < 32 ? name.slice(idx + 2) : name;
  }

  function hue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function monogram(slug) {
    const name = providerName(slug).replace(/[^A-Za-z0-9]/g, '');
    if (name.length <= 3) return name || '?';
    const caps = name.match(/[A-Z]/g);
    if (caps && caps.length >= 2 && caps[0] === name[0]) return caps[0] + caps[1];
    return name.charAt(0).toUpperCase() + name.charAt(1).toLowerCase();
  }

  /** "Anthropic (anthropic)" — humanised name plus the raw slug for tooltips. */
  function providerTitle(slug) {
    const label = providerName(slug);
    return label.toLowerCase() === String(slug || '').toLowerCase() ? label : `${label} (${slug})`;
  }

  function providerChip(slug, size, title) {
    return `<span class="mono-chip${size ? ' ' + size : ''}" style="--h:${hue(slug || '')}" title="${escapeHtml(title || providerTitle(slug))}" aria-hidden="true">${escapeHtml(monogram(slug))}</span>`;
  }

  function money(n) {
    if (n === undefined || n === null || isNaN(n)) return '—';
    if (n > 0 && n < 0.01) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
  }

  /**
   * Mini meters under the card metrics: log-scaled over the catalog's
   * min/max, computed once per catalog load.
   */
  function buildMeterRange() {
    const span = (vals) => {
      const v = vals.filter((x) => typeof x === 'number' && x > 0);
      if (!v.length) return null;
      return { lo: Math.log(Math.min(...v)), hi: Math.log(Math.max(...v)) };
    };
    meterRange = {
      price: span(allModels.flatMap((m) => [m.pricing?.promptPerMillion, m.pricing?.completionPerMillion])),
      context: span(allModels.map((m) => m.contextLength)),
      maxOut: span(allModels.map((m) => m.maxOutputTokens)),
    };
  }

  function meter(kind, value) {
    const r = meterRange && meterRange[kind];
    let pct = 0;
    if (r && typeof value === 'number' && value > 0) {
      pct = r.hi > r.lo ? (Math.log(value) - r.lo) / (r.hi - r.lo) : 1;
      pct = Math.round(Math.max(0.06, Math.min(1, pct)) * 100);
    }
    return `<span class="meter meter-${kind}" aria-hidden="true"><span class="meter-fill" style="width:${pct}%"></span></span>`;
  }

  /** Routers (openrouter/auto, …) bill the price of the model they pick; older caches hold them as negative prices. */
  function hasVariablePrice(model) {
    return !!model && !!model.pricing && (!!model.variablePricing || model.pricing.promptPerMillion < 0 || model.pricing.completionPerMillion < 0);
  }

  /**
   * The In · Out · Context · Max out strip, shared by Browse cards and the
   * agent-tab rows. `pricing` is undefined for a model that is no longer in
   * the synced catalog; its prices then read "—".
   */
  function metricsStrip({ pricing, isFree, variable, contextLength, maxOutputTokens, extraClass }) {
    // "Free" carries no per-million unit — only the priced branch gets "/M".
    // Routers bill the price of the model they pick, so they show "Varies".
    const priceCells = variable
      ? `<div class="metric metric-span2" title="Routes each request to a model and bills that model's price">
           <span class="metric-label">Price</span>
           <span class="metric-value">Varies</span>
           ${meter('price', 0)}
         </div>`
      : isFree
      ? `<div class="metric metric-free metric-span2">
           <span class="metric-label">Price</span>
           <span class="metric-value"><span class="free-pill">Free</span></span>
           ${meter('price', 0)}
         </div>`
      : `<div class="metric">
           <span class="metric-label">Input</span>
           <span class="metric-value">${money(pricing?.promptPerMillion)}${pricing ? '<span class="unit">/M</span>' : ''}</span>
           ${meter('price', pricing?.promptPerMillion)}
         </div>
         <div class="metric">
           <span class="metric-label">Output</span>
           <span class="metric-value">${money(pricing?.completionPerMillion)}${pricing ? '<span class="unit">/M</span>' : ''}</span>
           ${meter('price', pricing?.completionPerMillion)}
         </div>`;
    return `
      <div class="metrics ${extraClass || ''}">
        ${priceCells}
        <div class="metric">
          <span class="metric-label">Context</span>
          <span class="metric-value">${formatTokenCount(contextLength)}</span>
          ${meter('context', contextLength)}
        </div>
        <div class="metric">
          <span class="metric-label">Max out</span>
          <span class="metric-value">${formatTokenCount(maxOutputTokens)}</span>
          ${meter('maxOut', maxOutputTokens)}
        </div>
      </div>`;
  }

  /** Capability chips: icon + label, styled like the Browse filter chips. */
  function capIcons(caps, isFree) {
    const chip = (cls, ic, label, title) =>
      `<span class="cap cap-${cls}" title="${title}">${icon(ic)}<span class="cap-label">${label}</span></span>`;
    const out = [];
    if (caps.vision) out.push(chip('vision', 'eye', 'Vision', 'Vision — accepts images'));
    if (caps.toolCalling) out.push(chip('tools', 'wrench', 'Tools', 'Tools — supports tool calling'));
    if (caps.reasoning) out.push(chip('reasoning', 'bulb', 'Reasoning', 'Reasoning — thinks before answering'));
    if (caps.imageOutput) out.push(chip('image', 'image', 'Image Out', 'Image Out — can generate images'));
    if (isFree) out.push('<span class="free-pill" title="Free on OpenRouter">Free</span>');
    return out.join('');
  }

  /** Capture which button has focus so a re-render can restore it. */
  function withFocus(container, render) {
    const ae = document.activeElement;
    const key = ae && container.contains(ae) ? ae.getAttribute('data-focus-key') : null;
    render();
    if (key) {
      const el = container.querySelector(`[data-focus-key="${cssEscape(key)}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
  }

  // ===== RENDERING: Browse =====
  function renderModels() {
    const filtered = Filters.apply(allModels);
    dom.statsFiltered.textContent = filtered.length;
    dom.statsCount.textContent = allModels.length;
    dom.searchInput.placeholder = allModels.length
      ? `Search ${allModels.length} models, providers, IDs…`
      : 'Search models, providers, IDs…';
    dom.app.classList.toggle('no-models', allModels.length === 0);
    updateApiKeyUI();
    renderDock();

    if (filtered.length === 0 && allModels.length === 0) {
      lastListKey = '';
      dom.modelList.innerHTML = renderEmptyState();
      return;
    }

    if (filtered.length === 0) {
      lastListKey = '';
      dom.modelList.innerHTML = renderNoResults();
      return;
    }

    const toRender = filtered.slice(0, 100);
    const key = toRender.map(m => m.id).join('|');
    const animate = key !== lastListKey;
    lastListKey = key;

    withFocus(dom.modelList, () => {
      dom.modelList.classList.toggle('animate-in', animate);
      dom.modelList.innerHTML = toRender.map((model, i) => renderModelCard(model, i)).join('')
        + (filtered.length > 100 ? `
          <div class="list-cap-note">
            ${icon('info')}<span class="stats-text">Showing 100 of ${filtered.length} — refine your search to see more</span>
          </div>` : '');
    });
  }

  /** Is this model saved in the given agent's list (active or not)? */
  function isInRoster(target, modelId) {
    return (agentRosters[target] || []).some(m => m.id === modelId);
  }

  /** The model an agent is currently wired to, or undefined. */
  function activeModelOf(target) {
    const st = integrationStatuses.find(s => s.target === target);
    return st?.active ? st.modelId : undefined;
  }

  function renderModelCard(model, index) {
    const isActiveInCopilot = activeCopilotModels.some(m => m.id === model.id);
    const inClaudeList = isInRoster('claude-code', model.id);
    const inCodexList = isInRoster('codex', model.id);
    const isActiveInClaude = activeModelOf('claude-code') === model.id;
    const isActiveInCodex = activeModelOf('codex') === model.id;
    const delay = Math.min(index * 22, 220);
    const descOpen = openDescriptions.has(model.id);

    const liveIn = isActiveInClaude ? 'claude' : isActiveInCodex ? 'codex' : '';

    const ctx = formatTokenCount(model.contextLength);
    const maxOut = formatTokenCount(model.maxOutputTokens);

    const descSnippet = model.description
      ? model.description.substring(0, 220) + (model.description.length > 220 ? '...' : '')
      : '';

    const caps = capIcons(model.capabilities, false);
    const id = escapeHtml(model.id);
    const cls = [
      'model-card',
      isActiveInCopilot || inClaudeList || inCodexList ? 'selected' : '',
      liveIn ? `is-live live-${liveIn}` : '',
      descOpen ? 'desc-open' : '',
    ].filter(Boolean).join(' ');

    return `
      <article class="${cls}" style="--i:${index}; animation-delay:${delay}ms" data-model-id="${id}">
        <div class="model-card-header">
          ${providerChip(model.provider)}
          <div class="model-card-info">
            <div class="model-card-name" title="${escapeHtml(model.name)}">${escapeHtml(shortName(model.name))}</div>
            <div class="model-card-id" title="${escapeHtml(providerTitle(model.provider))} · ${id}">${id}</div>
          </div>
        </div>
        ${caps ? `<div class="model-card-caps caps-row" aria-label="Capabilities">${caps}</div>` : ''}

        ${metricsStrip({
          pricing: model.pricing,
          isFree: model.isFree,
          variable: hasVariablePrice(model),
          contextLength: model.contextLength,
          maxOutputTokens: model.maxOutputTokens,
        })}

        ${descSnippet ? `
          <div class="model-card-desc">
            <button class="model-card-desc-toggle" aria-expanded="${descOpen ? 'true' : 'false'}" data-focus-key="desc:${id}">
              <span class="desc-arrow">${icon('chevRight')}</span><span>Description</span>
            </button>
            <div class="model-card-desc-body"><div class="model-card-desc-text">${escapeHtml(descSnippet)}</div></div>
          </div>
        ` : ''}

        <div class="card-targets" role="group" aria-label="Use ${escapeHtml(shortName(model.name))} in">
          ${targetButton('copilot', model.id, isActiveInCopilot ? 'in' : 'add',
              isActiveInCopilot ? 'Remove from Copilot Chat' : 'Add to the Copilot Chat model picker')}
          ${targetButton('claude-code', model.id, isActiveInClaude ? 'live' : inClaudeList ? 'in' : 'add',
              inClaudeList
                ? (isActiveInClaude
                    ? 'Remove from the Claude Code list (Claude Code goes back to its own model)'
                    : 'Remove from the Claude Code list')
                : 'Add to the Claude Code list')}
          ${targetButton('codex', model.id, isActiveInCodex ? 'live' : inCodexList ? 'in' : 'add',
              inCodexList
                ? (isActiveInCodex
                    ? 'Remove from the Codex list (Codex goes back to its own model)'
                    : 'Remove from the Codex list')
                : 'Add to the Codex list')}
        </div>
      </article>
    `;
  }

  const TARGET_UI = {
    'copilot':     { cls: 'copilot', glyph: 'copilot', label: 'Copilot',     short: 'Copilot' },
    'claude-code': { cls: 'claude',  glyph: 'claude',  label: 'Claude Code', short: 'Claude' },
    'codex':       { cls: 'codex',   glyph: 'codex',   label: 'Codex',       short: 'Codex' },
  };

  /** One segment of the card's agent toggle group: ＋ add / ✓ in list / ● active. */
  function targetButton(target, modelId, state, title) {
    const ui = TARGET_UI[target];
    const stateIcon = state === 'live' ? icon('dot', 'tb-state') : state === 'in' ? icon('check', 'tb-state') : icon('plus', 'tb-state');
    const stateText = state === 'live' ? 'active' : state === 'in' ? 'in list' : 'add';
    const id = escapeHtml(modelId);
    // Wide cards spell membership out ("In Codex", "Running in Claude Code").
    const prefix = state === 'live' ? 'Running in ' : state === 'in' ? 'In ' : '';
    return `
      <button class="target-btn target-${ui.cls} state-${state} ${state !== 'add' ? 'active' : ''}"
              data-target="${target}" data-model-id="${id}" data-focus-key="t:${target}:${id}"
              aria-pressed="${state !== 'add' ? 'true' : 'false'}"
              aria-label="${ui.label}: ${stateText}"
              title="${title}">
        ${stateIcon}<span class="tb-glyph">${icon(ui.glyph)}</span><span class="tb-label">${prefix ? `<span class="tb-prefix">${prefix}</span>` : ''}<span class="tb-long">${ui.label}</span><span class="tb-short">${ui.short}</span></span>
      </button>`;
  }

  // ===== RENDERING: dock (tabs as live status tiles) =====
  function updateCounts() {
    if (dom.copilotCount) {
      dom.copilotCount.textContent = activeCopilotModels.length;
      dom.copilotCount.classList.toggle('is-zero', activeCopilotModels.length === 0);
    }
    // Agent badges count saved models, like Copilot's — a dot marks the one
    // that is actually wired in.
    setAgentBadge(dom.claudeCount, 'claude-code');
    setAgentBadge(dom.codexCount, 'codex');
    renderDock();
  }

  function setAgentBadge(el, target) {
    if (!el) return;
    const count = (agentRosters[target] || []).length;
    el.textContent = count;
    el.classList.toggle('tab-badge-live', !!activeModelOf(target));
    el.classList.toggle('is-zero', count === 0);
  }

  /**
   * One dock tile. The visible text is aria-hidden; the button's aria-label
   * and title carry the full status. `short` shows below 520px of dock width,
   * `long` above it.
   */
  function setTile(btn, el, { state, short, long, label }) {
    if (!el || !btn) return;
    const key = [state, short, long || '', label].join('\u0001');
    if (dockCache[btn.id] === key) return;
    dockCache[btn.id] = key;
    el.className = `tile-sub sub-${state}`;
    el.innerHTML = `<span class="sub-dot"></span>`
      + `<span class="tile-sub-text sub-short">${escapeHtml(short)}</span>`
      // Long form is drawn from data-text by CSS, so the tile's text content
      // stays the short status word.
      + `<span class="tile-sub-text sub-long" data-text="${escapeHtml(long || short)}"></span>`;
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  /** Display name for an agent model id: catalog short name, roster name or the id tail. */
  function modelShort(id, roster) {
    const m = allModels.find(x => x.id === id);
    if (m) return shortName(m.name);
    const r = (roster || []).find(x => x.id === id);
    if (r && r.name) return shortName(r.name);
    return String(id || 'OpenRouter').split('/').pop();
  }

  function renderDock() {
    // Browse
    if (!apiKeyKnown) {
      setTile(dom.tabBrowse, dom.browseSub, { state: 'muted', short: 'Catalog', label: 'Browse, loading the model catalog' });
    } else if (!hasApiKey) {
      setTile(dom.tabBrowse, dom.browseSub, { state: 'warn', short: 'No API key', label: 'Browse, no API key set' });
    } else if (!allModels.length) {
      setTile(dom.tabBrowse, dom.browseSub, { state: 'muted', short: 'Not synced', label: 'Browse, catalog not synced yet' });
    } else {
      const n = allModels.length;
      setTile(dom.tabBrowse, dom.browseSub, { state: 'muted', short: `${n} models`, long: `${n} models · OpenRouter`, label: `Browse, ${n} models` });
    }

    // Copilot
    const n = activeCopilotModels.length;
    const names = activeCopilotModels.map(m => shortName(m.name || m.id));
    setTile(dom.tabCopilot, dom.copilotSub, n
      ? { state: 'live', short: `${n} live`, long: `${n} live · ${names.join(', ')}`, label: `Copilot, ${n} live: ${names.join(', ')}` }
      : { state: 'idle', short: 'None yet', long: 'No models yet', label: 'Copilot, no models yet' });
    dom.tabCopilot.classList.toggle('is-live', n > 0);

    // Claude Code / Codex
    for (const [target, el, btn] of [['claude-code', dom.claudeSub, dom.tabClaude], ['codex', dom.codexSub, dom.tabCodex]]) {
      const st = integrationStatuses.find(s => s.target === target);
      const name = AGENT_META[target].name;
      const roster = agentRosters[target] || [];
      const saved = `${roster.length} saved`;
      const model = st && st.active ? modelShort(st.modelId, roster) : '';
      btn.classList.toggle('is-live', !!(st && st.active));
      btn.classList.toggle('is-pending', !!pendingReload[target]);
      let t;
      if (pendingReload[target]) {
        const what = model || 'Default';
        t = { state: 'warn', short: 'Reload', long: `${what} · Reload needed`,
              label: `${name}, ${saved}, restart needed to apply ${model || 'the default model'}` };
      } else if (!st) {
        t = { state: 'muted', short: 'Checking', long: 'Checking…', label: `${name}, checking status` };
      } else if (!st.installed) {
        t = { state: 'off', short: 'Missing', long: 'Not installed', label: `${name}, not installed` };
      } else if (st.active) {
        t = { state: 'live', short: model, long: `${model} · ${saved}`, label: `${name}, ${saved}, running ${model}` };
      } else {
        t = { state: 'idle', short: 'Default', long: `Default · ${saved}`, label: `${name}, ${saved}, using default model` };
      }
      setTile(btn, el, t);
    }
  }

  // ===== RENDERING: Copilot tab =====
  function renderCopilotModels() {
    if (!dom.copilotModelsList) return;
    const n = activeCopilotModels.length;

    if (dom.copilotHero) {
      dom.copilotHero.innerHTML = `
        <section class="hero hero-copilot ${n ? 'hero-live' : ''}">
          <div class="hero-head">
            <span class="hero-glyph">${icon('copilot')}</span>
            <div class="hero-title-wrap">
              <h2 class="hero-title">Copilot Chat</h2>
              <span class="status-pill ${n ? 'pill-live' : 'pill-idle'}"><span class="sub-dot"></span>${n ? `${n} live in the model picker` : 'No models yet'}</span>
            </div>
          </div>
          <p class="hero-text">Models available in the Copilot Chat model picker under <b>OpenRouter Maestro</b>.
          You can enable as many as you like from the <b>Browse</b> tab.</p>
          ${n ? `<div class="hero-stack" aria-hidden="true">${activeCopilotModels.slice(0, 5).map(m => providerChip(m.id.split('/')[0], 'chip-stack', shortName(m.name || m.id))).join('')}${n > 5 ? `<span class="mono-chip chip-stack chip-more" title="${n - 5} more">+${n - 5}</span>` : ''}</div>` : ''}
        </section>`;
    }

    if (n === 0) {
      dom.copilotModelsList.innerHTML = emptyState({
        icon: 'copilot', tone: 'copilot',
        title: 'No models in Copilot yet',
        desc: 'In the <b>Browse</b> tab, press a model card\'s <b>＋ Copilot</b> button — it appears in the Copilot Chat model picker instantly.',
        button: { label: 'Browse models', action: 'browse', icon: 'compass' },
      });
      return;
    }

    withFocus(dom.copilotModelsList, () => {
      dom.copilotModelsList.innerHTML = `
        <div class="section-head">
          <h3 class="section-title">Live in Copilot</h3>
          <span class="section-hint">${n} model${n === 1 ? '' : 's'} · all usable at once</span>
        </div>
        <div class="roster-list">
          ${activeCopilotModels.map((am, i) =>
            renderAgentModelCard({
              id: am.id,
              name: am.name,
              fallback: am,
              agent: 'copilot',
              state: 'live',
              trash: `
                <button class="btn-icon btn-icon-danger" data-remove-copilot="${escapeHtml(am.id)}" data-focus-key="rm:${escapeHtml(am.id)}"
                        title="Remove from Copilot" aria-label="Remove ${escapeHtml(shortName(am.name))} from Copilot">${icon('trash')}</button>`,
              note: renderEffortControl(am, i),
            })
          ).join('')}
        </div>`;
    });
  }

  /**
   * The saved-model row shared by all three agent tabs. Copilot, Claude Code
   * and Codex render the same row — only the actions differ — so a model
   * looks the same wherever it is listed.
   *
   * `fallback` supplies capability/limit hints for models that are no longer in
   * the synced catalog (Copilot's stored entries carry their own copy).
   */
  function renderAgentModelCard({ id, name, fallback, primary, trash, extraClass, note, agent, state }) {
    const full = allModels.find(m => m.id === id);

    const metrics = metricsStrip({
      pricing: full?.pricing,
      isFree: !!full?.isFree,
      variable: hasVariablePrice(full),
      contextLength: fallback?.maxInputTokens || full?.contextLength,
      maxOutputTokens: fallback?.maxOutputTokens || full?.maxOutputTokens,
      extraClass: 'metrics-row',
    });

    const caps = full
      ? capIcons(full.capabilities, false)
      : capIcons({ vision: fallback?.vision, toolCalling: fallback?.toolCalling }, false);

    const displayName = full ? full.name : name;
    const slug = (id || '').split('/')[0];

    // Every row has the same anatomy (a CSS grid): name/id + actions, then the
    // meta line, then capability glyphs, then the optional effort row. Below
    // 360px the primary action drops to the glyph row so the name keeps the
    // full width.
    return `
      <div class="active-model-card roster-row agent-${agent || 'copilot'} ${primary ? 'has-primary' : 'no-primary'} ${state === 'live' ? 'row-live' : ''} ${extraClass || ''}" data-model-id="${escapeHtml(id)}">
        <span class="row-chip">${providerChip(slug)}</span>
        <div class="row-info active-model-details">
          <span class="active-model-name" title="${escapeHtml(displayName)}">${escapeHtml(shortName(displayName))}</span>
          <span class="active-model-id" title="${escapeHtml(providerTitle(slug))} · ${escapeHtml(id)}">${escapeHtml(id)}</span>
        </div>
        ${primary ? `<div class="row-primary">${primary}</div>` : ''}
        <div class="row-trash">${trash || ''}</div>
        <div class="row-meta">${metrics}</div>
        <div class="row-caps model-card-caps" aria-label="Capabilities">${caps}</div>
        ${note ? `<div class="row-note">${note}</div>` : ''}
      </div>
    `;
  }

  const AGENT_META = {
    'claude-code': {
      icon: 'claude',
      cls: 'claude',
      name: 'Claude Code',
      defaultLabel: 'Claude Code\'s own model (Anthropic)',
      how: 'Keep as many models in this list as you like. Claude Code itself can only run <b>one at a time</b>, so activating one writes it into Claude Code\'s settings; everything else just waits here.',
      steps: [
        'Add models from <b>Browse</b> with the <b>＋ Claude Code</b> button.',
        'Press <b>Activate</b> on the one you want to run.',
        'Start a <b>new Claude Code session</b> — running sessions keep their old config.',
        'No Anthropic login needed; your OpenRouter key authenticates. Your Claude subscription is untouched and comes back the moment you switch to the default.',
      ],
    },
    'codex': {
      icon: 'codex',
      cls: 'codex',
      name: 'Codex',
      defaultLabel: 'Codex\'s own model (OpenAI)',
      how: 'Keep as many models in this list as you like. Codex itself can only run <b>one at a time</b>, so activating one writes an <code>openrouter</code> provider into <code>~/.codex/config.toml</code> (shared by the Codex CLI and IDE extension).',
      steps: [
        'Add models from <b>Browse</b> with the <b>＋ Codex</b> button.',
        'Press <b>Activate</b> on the one you want to run.',
        '<b>Restart VS Code once</b> after the first activation so Codex sees the OPENROUTER_API_KEY environment variable.',
        'No ChatGPT sign-in needed. Codex\'s own picker labels the model "Custom" — the real model is the activated one.',
      ],
      caveatTitle: 'Thinking steps stay hidden for most OpenRouter models',
      caveat: 'Thinking steps stay hidden for most OpenRouter models. Measured against Codex 0.148: OpenRouter streams raw reasoning as <code>response.reasoning_text.*</code>, but Codex only renders reasoning <i>summaries</i>, so it drops those events. The model does think — the run reports reasoning tokens and you are billed for them — the steps just are not shown. No config setting changes this (<code>model_catalog_json</code> was tested too); it needs a fix on the Codex side. Models whose provider emits real summaries (OpenAI\'s own) do display.',
    },
  };

  function renderAgentDetails() {
    renderAgentDetail('claude-code', dom.claudeAgentCard);
    renderAgentDetail('codex', dom.codexAgentCard);
    renderDock();
  }

  /** Context-window ring: fraction of 1M tokens, drawn as an SVG arc. */
  function ring(contextLength, glyph, elapsed) {
    const animate = typeof elapsed === 'number';
    const pct = contextLength ? Math.max(4, Math.min(100, (contextLength / 1000000) * 100)) : 0;
    const label = contextLength ? formatTokenCount(contextLength) : '';
    return `
      <div class="ring ${contextLength ? '' : 'ring-empty'} ${animate ? 'animate' : ''}" ${contextLength ? `role="img" aria-label="Context window ${label} tokens" title="Context window: ${label} tokens"` : 'aria-hidden="true"'}>
        <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
          <circle class="ring-track" cx="20" cy="20" r="15.9155"/>
          ${contextLength ? `<circle class="ring-arc" cx="20" cy="20" r="15.9155" stroke-dasharray="${pct.toFixed(1)} 100"${animate && elapsed ? ` style="animation-delay:-${elapsed}ms"` : ''}/>` : ''}
        </svg>
        <span class="ring-label">${contextLength ? `<b>${label}</b><small>ctx</small>` : icon(glyph)}</span>
      </div>`;
  }

  function renderAgentDetail(target, container) {
    if (!container) return;

    const meta = AGENT_META[target];
    const st = integrationStatuses.find(s => s.target === target);
    const activeId = st?.active ? st.modelId : undefined;
    const roster = agentRosters[target] || [];
    const activeFull = activeId ? allModels.find(m => m.id === activeId) : undefined;
    const activeEntry = activeId ? roster.find(r => r.id === activeId) : undefined;

    let statusPill;
    let heroNotes = '';
    let guide = '';

    if (!st) {
      statusPill = `<span class="status-pill pill-muted">${icon('clock')}Checking…</span>`;
    } else if (!st.installed) {
      statusPill = `<span class="status-pill pill-off">${icon('slash')}Not detected</span>`;
      heroNotes = note('warn', st.detail ? escapeHtml(st.detail) : `${meta.name} was not found on this machine. Install it first, then come back here.`);
    } else if (st.active) {
      statusPill = '<span class="status-pill pill-live"><span class="sub-dot"></span>Running on OpenRouter</span>';
      heroNotes = st.detail ? note('info', escapeHtml(st.detail)) : '';
      guide = `
        ${meta.caveat ? disclosure('bulb', meta.caveatTitle, meta.caveat, 'note-caveat') : ''}
        ${note('warn', `Uninstalling Maestro does <b>not</b> undo this — VS Code runs no code on uninstall. Switch back to <b>${escapeHtml(meta.defaultLabel)}</b> first if you want ${escapeHtml(meta.name)} on its own provider.`)}
      `;
    } else {
      statusPill = '<span class="status-pill pill-idle"><span class="sub-dot"></span>Running on its own model</span>';
      heroNotes = st.detail ? note('warn', escapeHtml(st.detail), 'agent-warn') : '';
      guide = `
        <div class="guide">
          <p class="agent-note guide-how">${meta.how}</p>
          <ol class="agent-steps">${meta.steps.map((s, i) => `<li><span class="step-num">${i + 1}</span><span>${s}</span></li>`).join('')}</ol>
        </div>
      `;
    }

    const installed = st?.installed !== false;

    // Both agents read their config when they start, so a session that is
    // already open keeps answering as the old model. Without this banner that
    // looks exactly like "switching did nothing".
    const reloadBanner = pendingReload[target] ? `
      <div class="reload-banner" role="alert">
        <div class="reload-banner-head">
          <span class="reload-icon">${icon('reload')}</span>
          <div class="reload-banner-copy">
            <b>Restart needed</b>
            <span>${escapeHtml(meta.name)}'s config is updated — running sessions keep the old model.</span>
          </div>
        </div>
        <div class="reload-banner-actions">
          <button class="btn btn-amber btn-sm" data-reload-window data-focus-key="reload">${icon('reload')}Reload Window</button>
          <details class="reload-why">
            <summary>Why?</summary>
            <div class="reload-banner-text">
              <b>Restart needed.</b> ${escapeHtml(meta.name)}'s config on disk is already updated, but a
              session that is <b>currently running keeps the model it started with</b> — that is why it can
              still answer as the old one. Reload the window, then start a new ${escapeHtml(meta.name)} session.
              A ${escapeHtml(meta.name)} CLI running in a terminal has to be restarted on its own.
            </div>
          </details>
        </div>
      </div>` : '';

    // "Now running" block — answers job #1 inside the agent tab.
    // The ring draws in only when the shown model changed since it was last
    // visible — not on every status echo or tab switch.
    const visible = activeTab === (target === 'codex' ? 'codex' : 'claude');
    const ringKey = `${activeId || ''}:${activeFull ? activeFull.contextLength : 0}`;
    let ringAnim = null; // null = static, else ms already elapsed in the draw-in
    if (visible && activeFull) {
      const prev = ringShown[target];
      if (!prev || prev.key !== ringKey) {
        ringShown[target] = { key: ringKey, at: performance.now() };
        ringAnim = 0;
      } else if (performance.now() - prev.at < RING_MS) {
        // A re-render during the draw-in continues it instead of restarting.
        ringAnim = Math.round(performance.now() - prev.at);
      }
    }

    let nowName, nowSub, nowRing, nowMetrics = '', nowLabel = 'Now running';
    if (!st) {
      nowLabel = 'Status'; nowName = 'Checking…'; nowSub = ''; nowRing = ring(0, 'clock');
    } else if (!st.installed) {
      nowLabel = 'Status'; nowName = 'Not installed'; nowSub = 'Install it, then come back here'; nowRing = ring(0, 'slash');
    } else if (activeId) {
      nowName = shortName(activeFull ? activeFull.name : (activeEntry ? activeEntry.name : activeId));
      nowSub = activeId;
      nowRing = ring(activeFull ? activeFull.contextLength : 0, meta.icon, ringAnim);
      if (activeFull) {
        const price = hasVariablePrice(activeFull)
          ? '<span class="nm-item">Price <b>varies</b></span>'
          : activeFull.isFree
          ? '<span class="nm-item"><b>Free</b></span>'
          : `<span class="nm-item">In <b>${money(activeFull.pricing.promptPerMillion)}</b></span><span class="nm-sep" aria-hidden="true">·</span><span class="nm-item">Out <b>${money(activeFull.pricing.completionPerMillion)}</b> /M</span>`;
        nowMetrics = `<span class="now-metrics">${price}<span class="nm-sep nm-sep-last" aria-hidden="true">·</span><span class="nm-item nm-last">Max out <b>${formatTokenCount(activeFull.maxOutputTokens)}</b></span></span>`;
      }
    } else {
      nowName = meta.defaultLabel; nowSub = 'Default provider — Maestro is not wired in'; nowRing = ring(0, meta.icon);
    }

    const wasOpen = container.querySelector('details.reload-why')?.open;
    const caveatOpen = container.querySelector('details.note-caveat')?.open;

    withFocus(container, () => {
      container.innerHTML = `
        ${reloadBanner}
        <div class="agent-layout">
          <div class="agent-col">
            <section class="hero active-model-card agent-card agent-${target} hero-${meta.cls} ${activeId ? 'hero-live' : ''}">
              <div class="hero-head">
                <span class="hero-glyph">${icon(meta.icon)}</span>
                <div class="hero-title-wrap">
                  <h2 class="hero-title active-model-name">${meta.name}</h2>
                  ${statusPill}
                </div>
              </div>
              <div class="now-running">
                ${nowRing}
                <div class="now-text">
                  <span class="now-label">${nowLabel}</span>
                  <span class="now-name" title="${escapeHtml(nowName)}">${escapeHtml(nowName)}</span>
                  ${nowSub ? `<span class="now-sub" title="${escapeHtml(nowSub)}">${escapeHtml(nowSub)}</span>` : ''}
                  ${nowMetrics}
                </div>
              </div>
              ${st?.configPath ? `<div class="config-path model-card-id" title="${escapeHtml(st.configPath)}">${icon('file')}<span>${escapeHtml(st.configPath)}</span></div>` : ''}
              ${heroNotes}
            </section>
          </div>

          <div class="agent-col agent-col-main">
            <section class="roster">
              <div class="section-head roster-header">
                <h3 class="section-title roster-title">Your models</h3>
                <span class="section-hint roster-hint">${roster.length} saved · one runs at a time</span>
              </div>
              <div class="roster-list">
                ${roster.map(entry => renderRosterRow(target, entry, activeId, installed)).join('')}
                <div class="active-model-card card-default ${activeId ? '' : 'card-active'}"
                     title="Put ${escapeHtml(meta.name)} back on its own provider — your list is kept">
                  <div class="active-model-header">
                    <span class="default-glyph">${icon(meta.icon)}</span>
                    <div class="active-model-details">
                      <span class="active-model-name">${escapeHtml(meta.defaultLabel)}</span>
                      <span class="active-model-id default-sub">Default — Maestro's config is removed and the original settings restored</span>
                    </div>
                    <div class="card-actions">
                      ${activeId
                        ? `<button class="btn btn-sm btn-ghost" data-agent-default-btn data-focus-key="default">${icon('undo')}Use default</button>`
                        : `<span class="card-state state-pill pill-idle">${icon('check')}In use</span>`}
                    </div>
                  </div>
                </div>
              </div>
              ${roster.length === 0 ? `
                <div class="agent-note roster-empty">
                  ${icon('info')}<span>Nothing saved yet — open <b>Browse</b> and press <b>＋ ${escapeHtml(meta.name)}</b> on any model card.</span>
                </div>` : ''}
            </section>
            ${guide ? `<section class="guide-wrap">${guide}</section>` : ''}
          </div>
        </div>
      `;
      if (wasOpen) { const d = container.querySelector('details.reload-why'); if (d) d.open = true; }
      if (caveatOpen) { const d = container.querySelector('details.note-caveat'); if (d) d.open = true; }
    });
  }

  function note(kind, html, extra) {
    const ic = kind === 'warn' ? 'warn' : 'info';
    return `<div class="agent-note note note-${kind} ${extra || ''}">${icon(ic)}<span>${html}</span></div>`;
  }

  function disclosure(ic, title, body, extra) {
    return `
      <details class="note note-disclosure ${extra || ''}">
        <summary>${icon(ic)}<span>${title}</span>${icon('chevDown', 'disc-chev')}</summary>
        <div class="agent-note disclosure-body">${body}</div>
      </details>`;
  }

  function renderRosterRow(target, entry, activeId, installed) {
    const isActive = entry.id === activeId;
    const meta = AGENT_META[target];
    const id = escapeHtml(entry.id);

    const primary = isActive
      ? '<span class="card-state state-pill pill-live" title="This model is active"><span class="sub-dot"></span>Active</span>'
      : `<button class="btn btn-sm btn-activate" data-activate="${id}" data-focus-key="act:${id}" ${installed ? '' : 'disabled'}
                 title="Make ${escapeHtml(meta.name)} run this model">${icon('play')}Activate</button>`;
    const trash = `
      <button class="btn-icon btn-icon-danger" data-remove="${id}" data-focus-key="rm:${id}"
              title="Remove from ${escapeHtml(meta.name)}" aria-label="Remove ${escapeHtml(shortName(entry.name))} from ${escapeHtml(meta.name)}">${icon('trash')}</button>`;

    return renderAgentModelCard({
      id: entry.id,
      name: entry.name,
      primary,
      trash,
      agent: meta.cls,
      state: isActive ? 'live' : '',
      extraClass: isActive ? 'card-active' : '',
    });
  }

  /**
   * Per-model thinking-effort picker, rendered only on Copilot cards. Mirrors
   * the Copilot model-picker "Thinking Effort" submenu; both write the same
   * stored override. Rendered as a segmented radio group (one click).
   */
  function renderEffortControl(am, index) {
    const efforts = am.supportedEfforts || [];
    const labelId = `eff-${index}-${String(am.id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    if (!efforts.length) {
      return '';
    }
    const current = am.reasoningEffort || efforts[0];
    const options = efforts.map((effort) => {
      const on = effort === current;
      const label = effort.charAt(0).toUpperCase() + effort.slice(1);
      return `<button class="effort-opt" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}"
                      data-effort="${escapeHtml(effort)}" data-model-id="${escapeHtml(am.id)}"
                      data-focus-key="eff:${escapeHtml(am.id)}:${escapeHtml(effort)}">${escapeHtml(label)}</button>`;
    }).join('');
    return `
      <div class="effort-row">
        <span class="effort-label" id="${labelId}">${icon('bulb')}Thinking effort</span>
        <div class="effort-seg" role="radiogroup" aria-labelledby="${labelId}">${options}</div>
      </div>
    `;
  }

  // ===== EMPTY STATES =====
  function emptyState({ icon: ic, tone, title, desc, button }) {
    return `
      <div class="empty-state tone-${tone || 'brand'}">
        <div class="empty-state-icon"><span class="empty-halo"></span>${icon(ic)}</div>
        <div class="empty-state-title">${title}</div>
        <div class="empty-state-desc">${desc}</div>
        ${button ? `<button class="btn ${button.secondary ? 'btn-ghost' : 'btn-primary'}" data-action="${button.action}">${button.icon ? icon(button.icon) : ''}${button.label}</button>` : ''}
      </div>`;
  }

  function renderEmptyState() {
    if (!apiKeyKnown) {
      return `<div class="skeleton-list" aria-hidden="true">${'<div class="sk-card"><span class="sk sk-a"></span><span class="sk sk-b"></span><span class="sk sk-c"></span></div>'.repeat(3)}</div>`;
    }
    if (!hasApiKey) {
      return emptyState({
        icon: 'key', tone: 'brand',
        title: 'Set Your API Key',
        desc: 'Enter your OpenRouter API key to start browsing models. Click the key icon above or the button below.',
        button: { label: 'Set API Key', action: 'setApiKey', icon: 'key' },
      });
    }
    return emptyState({
      icon: 'cloud', tone: 'brand',
      title: 'No Models Loaded',
      desc: 'Click the sync button to fetch available models from OpenRouter.',
      button: { label: 'Sync Models', action: 'syncModels', icon: 'refresh' },
    });
  }

  function renderNoResults() {
    return emptyState({
      icon: 'search', tone: 'muted',
      title: 'No Matching Models',
      desc: 'Try adjusting your search or filters.',
      button: { label: 'Clear Filters', action: 'resetFilters', icon: 'x', secondary: true },
    });
  }

  // ===== PROVIDER MENU =====
  function renderProviderDropdown() {
    const counts = {};
    allModels.forEach(m => { counts[m.provider] = (counts[m.provider] || 0) + 1; });
    const providers = Object.keys(counts).sort((a, b) => providerName(a).localeCompare(providerName(b)));
    const current = Filters.get().provider;
    dom.providerMenu.innerHTML = `
      <button class="provider-option ${!current ? 'selected' : ''}" role="menuitemradio" aria-checked="${!current}" data-provider="" tabindex="-1">
        <span class="mono-chip chip-all" aria-hidden="true">${icon('layers')}</span>
        <span class="po-name">All Providers</span>
        <span class="po-count">${allModels.length}</span>
        <span class="po-check">${icon('check')}</span>
      </button>
      <div class="po-sep" role="separator"></div>
      ${providers.map(p => `
        <button class="provider-option ${current === p ? 'selected' : ''}" role="menuitemradio" aria-checked="${current === p}" data-provider="${escapeHtml(p)}" title="${escapeHtml(providerTitle(p))}" tabindex="-1">
          ${providerChip(p)}
          <span class="po-name">${escapeHtml(providerName(p))}</span>
          <span class="po-count">${counts[p]}</span>
          <span class="po-check">${icon('check')}</span>
        </button>
      `).join('')}
    `;

    dom.providerMenu.querySelectorAll('.provider-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        const provider = e.currentTarget.dataset.provider;
        Filters.set('provider', provider);
        setProviderLabel(provider);
        setProviderMenu(false);
        renderModels();
        dom.providerMenu.querySelectorAll('.provider-option').forEach(o => {
          o.classList.remove('selected');
          o.setAttribute('aria-checked', 'false');
        });
        e.currentTarget.classList.add('selected');
        e.currentTarget.setAttribute('aria-checked', 'true');
        dom.providerBtn.focus();
      });
    });
  }

  function setProviderLabel(provider) {
    dom.providerLabel.textContent = provider ? providerName(provider) : 'All providers';
    dom.providerBtn.classList.toggle('has-value', !!provider);
  }

  // ===== UI HELPERS =====
  function setLoading(loading) {
    isLoading = loading;
    dom.loadingOverlay.classList.toggle('visible', loading);
    dom.loadingOverlay.setAttribute('aria-hidden', loading ? 'false' : 'true');
    dom.syncBtn.classList.toggle('spinning', loading);
    dom.app.classList.toggle('is-loading', loading);
  }

  function updateApiKeyUI() {
    dom.apiKeyBtn.classList.toggle('needs-key', apiKeyKnown && !hasApiKey);
    if (dom.apiKeyBanner) {
      // On Browse with nothing loaded, the empty-state hero already asks for
      // the key — don't say it twice.
      const heroShowsIt = activeTab === 'browse' && allModels.length === 0;
      dom.apiKeyBanner.style.display = (!apiKeyKnown || hasApiKey || heroShowsIt) ? 'none' : 'flex';
    }
  }

  function updateStats(total) {
    dom.statsCount.textContent = total || allModels.length;
  }

  /**
   * One toast at a time: a new toast replaces the visible one. While it is
   * up, the scroll area gets matching bottom padding, and if the control the
   * user just used sits under the toast, the list scrolls it clear.
   */
  function showToast(message, type = 'info') {
    const anchor = document.activeElement;
    if (toastEl && toastEl.classList.contains('error') && type !== 'error') {
      pendingToast = { message, type };  // never hide an error behind a success
      return;
    }
    pendingToast = null;
    dismissToast(true);

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.title = 'Click or press Escape to dismiss';
    const ic = type === 'success' ? 'check' : type === 'error' ? 'warn' : 'info';
    toast.innerHTML = `<span class="toast-icon">${icon(ic)}</span><span class="toast-text"></span>`
      + `<button class="toast-close" aria-label="Dismiss notification">${icon('x')}</button>`;
    toast.querySelector('.toast-text').textContent = message;
    dom.toastContainer.appendChild(toast);
    toastEl = toast;

    const h = toast.offsetHeight;
    dom.app.style.setProperty('--toast-space', `${h + 16 + 12}px`);
    dom.app.classList.add('has-toast');
    requestAnimationFrame(() => keepClearOfToast(anchor, toast));

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dismissToast(), type === 'error' ? 7000 : 4000);
  }

  function dismissToast(immediate) {
    clearTimeout(toastTimer);
    const t = toastEl;
    toastEl = null;
    if (!t) return;
    if (immediate) {
      t.remove();
    } else {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 300);
    }
    dom.app.classList.remove('has-toast');
    if (!immediate && pendingToast) {
      const next = pendingToast;
      pendingToast = null;
      setTimeout(() => showToast(next.message, next.type), 200);
    }
  }

  /** Scroll the views so the control the user just used is not under the toast. */
  function keepClearOfToast(anchor, toast) {
    if (!toast.isConnected) return;
    let el = anchor && anchor !== document.body && dom.views.contains(anchor) && anchor.isConnected ? anchor : document.activeElement;
    if (!el || !dom.views.contains(el)) return;
    el = el.closest('.card-targets, .roster-row, .effort-row, .card-default') || el;
    // Use the toast's resting position (its entrance animation offsets the rect).
    const bottom = dom.toastContainer.getBoundingClientRect().bottom;
    const top = bottom - toast.offsetHeight;
    const er = el.getBoundingClientRect();
    const overlap = er.bottom + 8 - top;
    if (overlap > 0 && er.top < bottom) dom.views.scrollBy({ top: overlap, behavior: 'auto' });
  }

  function formatTokenCount(count) {
    if (!count || count === 0) return 'N/A';
    if (count >= 1000000) {
      const v = count / 1000000;
      return `${Number.isInteger(Math.round(v * 10) / 10) ? Math.round(v) : v.toFixed(1)}M`;
    }
    if (count >= 1000) return `${(count / 1000).toFixed(0)}K`;
    return count.toString();
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/"/g, '&quot;');
  }

  // ===== GLOBAL FUNCTIONS =====
  window.removeModel = function(modelId) {
    vscodeApi.postMessage({ type: 'removeModel', modelId });
  };

  window.removeActiveModel = function(modelId) {
    vscodeApi.postMessage({ type: 'removeActiveModel', modelId });
  };

  window.setReasoningEffort = function(selectEl) {
    const modelId = selectEl.dataset.modelId;
    const effort = selectEl.value;
    if (!modelId || !effort) return;
    vscodeApi.postMessage({ type: 'setReasoningEffort', modelId, effort });
  };

  window.resetFilters = function() {
    Filters.reset();
    dom.searchInput.value = '';
    dom.searchClear.classList.remove('visible');
    for (const el of [dom.filterVision, dom.filterTools, dom.filterFree, dom.filterReasoning]) {
      if (!el) continue;
      el.classList.remove('active');
      el.setAttribute('aria-pressed', 'false');
    }
    dom.sortSelect.value = 'name-asc';
    setProviderLabel('');
    renderProviderDropdown();
    renderModels();
  };

  // ===== BOOT =====
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
