/**
 * OpenRouter Maestro — Main Application
 * Orchestrates UI rendering, user interaction, tabs, and extension communication.
 * Targets: Copilot Chat (native provider), Claude Code, OpenAI Codex.
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
  let isLoading = false;
  let activeTab = 'browse'; // 'browse' | 'active' | 'agents'
  let searchDebounceTimer = null;

  // ===== DOM REFS =====
  const $ = (sel) => document.querySelector(sel);

  const dom = {
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
    copilotModelsList: $('#copilot-models-list'),
    claudeAgentCard:   $('#claude-agent-card'),
    codexAgentCard:    $('#codex-agent-card'),
    searchInput:      $('#search-input'),
    searchClear:      $('#search-clear'),
    filterVision:     $('#filter-vision'),
    filterTools:      $('#filter-tools'),
    filterFree:       $('#filter-free'),
    sortSelect:       $('#sort-select'),
    providerBtn:      $('#provider-filter-btn'),
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

  // ===== INIT =====
  function init() {
    bindEvents();
    vscodeApi.onMessage(handleExtensionMessage);
    vscodeApi.postMessage({ type: 'ready' });
  }

  // ===== EVENT BINDING =====
  function bindEvents() {
    // Tabs
    dom.tabBrowse.addEventListener('click', () => switchTab('browse'));
    dom.tabCopilot.addEventListener('click', () => switchTab('copilot'));
    dom.tabClaude.addEventListener('click', () => switchTab('claude'));
    dom.tabCodex.addEventListener('click', () => switchTab('codex'));

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
    dom.searchClear.addEventListener('click', () => {
      dom.searchInput.value = '';
      dom.searchClear.classList.remove('visible');
      Filters.set('search', '');
      renderModels();
      dom.searchInput.focus();
    });

    // Filter chips
    dom.filterVision.addEventListener('click', () => {
      Filters.toggle('vision');
      dom.filterVision.classList.toggle('active');
      renderModels();
    });
    dom.filterTools.addEventListener('click', () => {
      Filters.toggle('toolCalling');
      dom.filterTools.classList.toggle('active');
      renderModels();
    });
    dom.filterFree.addEventListener('click', () => {
      Filters.toggle('free');
      dom.filterFree.classList.toggle('active');
      renderModels();
    });

    // Sort
    dom.sortSelect.addEventListener('change', () => {
      Filters.set('sortBy', dom.sortSelect.value);
      renderModels();
    });

    // Provider dropdown
    dom.providerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dom.providerMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => {
      dom.providerMenu.classList.remove('open');
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
      t.btn.classList.toggle('active', name === tab);
      t.content.classList.toggle('active', name === tab);
    }
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
        renderModels();
        renderProviderDropdown();
        renderCopilotModels();
        updateStats(msg.total);
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
        updateApiKeyUI();
        break;
      case 'syncComplete':
        if (msg.newModelsCount > 0) {
          showToast(`🆕 ${msg.newModelsCount} new model(s) found!`, 'success');
        } else {
          showToast('✅ Models synced, all up to date', 'info');
        }
        break;
    }
  }

  // ===== RENDERING =====
  function renderModels() {
    const filtered = Filters.apply(allModels);
    dom.statsFiltered.textContent = filtered.length;
    dom.statsCount.textContent = allModels.length;

    if (filtered.length === 0 && allModels.length === 0) {
      dom.modelList.innerHTML = renderEmptyState();
      return;
    }

    if (filtered.length === 0) {
      dom.modelList.innerHTML = renderNoResults();
      return;
    }

    const toRender = filtered.slice(0, 100);
    dom.modelList.innerHTML = toRender.map((model, i) => renderModelCard(model, i)).join('');

    if (filtered.length > 100) {
      dom.modelList.innerHTML += `
        <div class="stats-bar" style="justify-content:center; border:none; padding: var(--space-4);">
          <span class="stats-text">Showing 100 of ${filtered.length} — refine your search to see more</span>
        </div>
      `;
    }

    // Bind card target buttons (Copilot / Claude Code / Codex)
    dom.modelList.querySelectorAll('.target-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modelId = e.currentTarget.dataset.modelId;
        const target = e.currentTarget.dataset.target;

        if (target === 'copilot') {
          vscodeApi.postMessage({ type: 'toggleCopilot', modelId });
          return;
        }

        // Claude Code / Codex keep a saved list, like Copilot. The card button
        // only adds/removes list membership; which entry is *active* is chosen
        // in the agent's own tab.
        vscodeApi.postMessage({
          type: isInRoster(target, modelId) ? 'removeFromAgent' : 'addToAgent',
          target,
          modelId,
        });
      });
    });

    dom.modelList.querySelectorAll('.model-card-desc-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const desc = e.currentTarget.nextElementSibling;
        const arrow = e.currentTarget.querySelector('.desc-arrow');
        desc.classList.toggle('open');
        if (arrow) arrow.textContent = desc.classList.contains('open') ? '▾' : '▸';
      });
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
    const isSelected = selectedModelIds.has(model.id);
    const isActiveInCopilot = activeCopilotModels.some(m => m.id === model.id);
    const inClaudeList = isInRoster('claude-code', model.id);
    const inCodexList = isInRoster('codex', model.id);
    const isActiveInClaude = activeModelOf('claude-code') === model.id;
    const isActiveInCodex = activeModelOf('codex') === model.id;
    const delay = Math.min(index * 25, 250);

    const badges = [];
    if (model.capabilities.text) badges.push('<span class="badge badge-text">📝 Text</span>');
    if (model.capabilities.vision) badges.push('<span class="badge badge-vision">👁️ Vision</span>');
    if (model.capabilities.toolCalling) badges.push('<span class="badge badge-tools">🔧 Tools</span>');
    if (model.capabilities.reasoning) badges.push('<span class="badge badge-reasoning">🧠 Reasoning</span>');
    if (model.capabilities.imageOutput) badges.push('<span class="badge badge-image-out">🎨 Image Out</span>');
    if (model.isFree) badges.push('<span class="badge badge-free">✨ Free</span>');
    if (isActiveInCopilot) badges.push('<span class="badge badge-free" style="background:rgba(63,185,80,0.18); border-color:var(--accent-green);">✅ Active in Copilot</span>');
    if (isActiveInClaude) badges.push('<span class="badge badge-claude">🟠 Active in Claude Code</span>');
    else if (inClaudeList) badges.push('<span class="badge badge-claude">🟠 In Claude Code list</span>');
    if (isActiveInCodex) badges.push('<span class="badge badge-codex">🟢 Active in Codex</span>');
    else if (inCodexList) badges.push('<span class="badge badge-codex">🟢 In Codex list</span>');

    // "Free" carries no per-million unit — only the priced branch gets "/M".
    const promptPrice = model.isFree ? 'Free' : `$${model.pricing.promptPerMillion.toFixed(2)}/M`;
    const completionPrice = model.isFree ? 'Free' : `$${model.pricing.completionPerMillion.toFixed(2)}/M`;
    const priceClass = model.isFree ? 'free' : '';

    const ctx = formatTokenCount(model.contextLength);
    const maxOut = formatTokenCount(model.maxOutputTokens);

    const descSnippet = model.description
      ? model.description.substring(0, 220) + (model.description.length > 220 ? '...' : '')
      : '';

    return `
      <div class="model-card ${isActiveInCopilot || inClaudeList || inCodexList ? 'selected' : ''}" style="animation-delay: ${delay}ms" data-model-id="${model.id}">
        <div class="model-card-header">
          <div class="model-card-info">
            <div class="model-card-provider">${escapeHtml(model.provider)}</div>
            <div class="model-card-name">${escapeHtml(model.name)}</div>
            <div class="model-card-id">${escapeHtml(model.id)}</div>
          </div>
        </div>

        <div class="model-card-badges">${badges.join('')}</div>

        <div class="model-card-pricing">
          <div class="price-item">
            <span class="price-label">Input:</span>
            <span class="price-value ${priceClass}">${promptPrice}</span>
          </div>
          <div class="price-item">
            <span class="price-label">Output:</span>
            <span class="price-value ${priceClass}">${completionPrice}</span>
          </div>
        </div>

        <div class="model-card-stats">
          <div class="stat-item">
            <span>📊</span>
            <span class="stat-value">${ctx}</span>
            <span>context</span>
          </div>
          <div class="stat-item">
            <span>📤</span>
            <span class="stat-value">${maxOut}</span>
            <span>max output</span>
          </div>
        </div>

        ${descSnippet ? `
          <div class="model-card-desc">
            <button class="model-card-desc-toggle"><span class="desc-arrow">▸</span> Description</button>
            <div class="model-card-desc-text">${escapeHtml(descSnippet)}</div>
          </div>
        ` : ''}

        <div class="card-targets">
          <button class="target-btn target-copilot ${isActiveInCopilot ? 'active' : ''}"
                  data-target="copilot" data-model-id="${model.id}"
                  title="${isActiveInCopilot ? 'Remove from Copilot Chat' : 'Add to the Copilot Chat model picker'}">
            ${isActiveInCopilot ? '✓ In Copilot' : '＋ Copilot'}
          </button>
          <button class="target-btn target-claude ${inClaudeList ? 'active' : ''}"
                  data-target="claude-code" data-model-id="${model.id}"
                  title="${inClaudeList
                    ? (isActiveInClaude
                        ? 'Remove from the Claude Code list (Claude Code goes back to its own model)'
                        : 'Remove from the Claude Code list')
                    : 'Add to the Claude Code list'}">
            ${isActiveInClaude ? '● Claude Code' : inClaudeList ? '✓ Claude Code' : '＋ Claude Code'}
          </button>
          <button class="target-btn target-codex ${inCodexList ? 'active' : ''}"
                  data-target="codex" data-model-id="${model.id}"
                  title="${inCodexList
                    ? (isActiveInCodex
                        ? 'Remove from the Codex list (Codex goes back to its own model)'
                        : 'Remove from the Codex list')
                    : 'Add to the Codex list'}">
            ${isActiveInCodex ? '● Codex' : inCodexList ? '✓ Codex' : '＋ Codex'}
          </button>
        </div>
      </div>
    `;
  }

  function updateCounts() {
    if (dom.copilotCount) dom.copilotCount.textContent = activeCopilotModels.length;
    // Agent badges count saved models, like Copilot's — a dot marks the one
    // that is actually wired in.
    setAgentBadge(dom.claudeCount, 'claude-code');
    setAgentBadge(dom.codexCount, 'codex');
  }

  function setAgentBadge(el, target) {
    if (!el) return;
    const count = (agentRosters[target] || []).length;
    el.textContent = count;
    el.classList.toggle('tab-badge-live', !!activeModelOf(target));
  }

  function renderCopilotModels() {
    if (!dom.copilotModelsList) return;

    if (activeCopilotModels.length === 0) {
      dom.copilotModelsList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔵</div>
          <div class="empty-state-title">No models in Copilot yet</div>
          <div class="empty-state-desc">In the <b>Browse</b> tab, press a model card's <b>＋ Copilot</b> button — it appears in the Copilot Chat model picker instantly.</div>
        </div>
      `;
      return;
    }

    dom.copilotModelsList.innerHTML = activeCopilotModels.map(am =>
      renderAgentModelCard({
        id: am.id,
        name: am.name,
        fallback: am,
        actions: `<button class="btn btn-danger btn-sm" onclick="removeActiveModel('${am.id}')">
                    Remove from Copilot
                  </button>`,
      })
    ).join('');
  }

  /**
   * The saved-model card shared by all three agent tabs. Copilot, Claude Code
   * and Codex render exactly the same card — only the buttons in the header
   * differ — so a model looks the same wherever it is listed.
   *
   * `fallback` supplies capability/limit hints for models that are no longer in
   * the synced catalog (Copilot's stored entries carry their own copy).
   */
  function renderAgentModelCard({ id, name, fallback, actions, extraClass, note }) {
    const full = allModels.find(m => m.id === id);

    const promptPrice = full
      ? (full.isFree ? 'Free' : `$${full.pricing.promptPerMillion.toFixed(2)}/M`)
      : '';
    const completionPrice = full
      ? (full.isFree ? 'Free' : `$${full.pricing.completionPerMillion.toFixed(2)}/M`)
      : '';
    const priceClass = full?.isFree ? 'free' : '';

    const ctx = fallback?.maxInputTokens
      ? formatTokenCount(fallback.maxInputTokens)
      : (full ? formatTokenCount(full.contextLength) : 'N/A');
    const maxOut = fallback?.maxOutputTokens
      ? formatTokenCount(fallback.maxOutputTokens)
      : (full ? formatTokenCount(full.maxOutputTokens) : 'N/A');

    const badges = [];
    if (full) {
      if (full.capabilities.text) badges.push('<span class="badge badge-text">📝 Text</span>');
      if (full.capabilities.vision) badges.push('<span class="badge badge-vision">👁️ Vision</span>');
      if (full.capabilities.toolCalling) badges.push('<span class="badge badge-tools">🔧 Tools</span>');
      if (full.capabilities.reasoning) badges.push('<span class="badge badge-reasoning">🧠 Reasoning</span>');
      if (full.capabilities.imageOutput) badges.push('<span class="badge badge-image-out">🎨 Image Out</span>');
      if (full.isFree) badges.push('<span class="badge badge-free">✨ Free</span>');
    } else {
      if (fallback?.vision) badges.push('<span class="badge badge-vision">👁️ Vision</span>');
      if (fallback?.toolCalling) badges.push('<span class="badge badge-tools">🔧 Tools</span>');
    }

    return `
      <div class="active-model-card ${extraClass || ''}" data-model-id="${escapeHtml(id)}">
        <div class="active-model-header">
          <div class="active-model-details">
            <span class="active-model-name">${escapeHtml(full ? full.name : name)}</span>
            <span class="active-model-id">${escapeHtml(id)}</span>
          </div>
          <div class="card-actions">${actions}</div>
        </div>

        ${badges.length > 0 ? `<div class="model-card-badges" style="margin-top: var(--space-2); margin-bottom: var(--space-2);">${badges.join('')}</div>` : ''}

        <div class="active-model-meta">
          <div class="model-card-pricing" style="margin-bottom:0;">
            <div class="price-item">
              <span class="price-label">Input:</span>
              <span class="price-value ${priceClass}">${promptPrice}</span>
            </div>
            <div class="price-item">
              <span class="price-label">Output:</span>
              <span class="price-value ${priceClass}">${completionPrice}</span>
            </div>
          </div>
          <div class="model-card-stats" style="border-top:none; padding-top:0;">
            <div class="stat-item">
              <span>📊</span>
              <span class="stat-value">${ctx}</span>
              <span>context</span>
            </div>
            <div class="stat-item">
              <span>📤</span>
              <span class="stat-value">${maxOut}</span>
              <span>max output</span>
            </div>
          </div>
        </div>
        ${note || ''}
      </div>
    `;
  }

  const AGENT_META = {
    'claude-code': {
      icon: '🟠',
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
      icon: '🟢',
      name: 'Codex',
      defaultLabel: 'Codex\'s own model (OpenAI)',
      how: 'Keep as many models in this list as you like. Codex itself can only run <b>one at a time</b>, so activating one writes an <code>openrouter</code> provider into <code>~/.codex/config.toml</code> (shared by the Codex CLI and IDE extension).',
      steps: [
        'Add models from <b>Browse</b> with the <b>＋ Codex</b> button.',
        'Press <b>Activate</b> on the one you want to run.',
        '<b>Restart VS Code once</b> after the first activation so Codex sees the OPENROUTER_API_KEY environment variable.',
        'No ChatGPT sign-in needed. Codex\'s own picker labels the model "Custom" — the real model is the activated one.',
      ],
      caveat: 'Thinking steps stay hidden for most OpenRouter models. Measured against Codex 0.148: OpenRouter streams raw reasoning as <code>response.reasoning_text.*</code>, but Codex only renders reasoning <i>summaries</i>, so it drops those events. The model does think — the run reports reasoning tokens and you are billed for them — the steps just are not shown. No config setting changes this (<code>model_catalog_json</code> was tested too); it needs a fix on the Codex side. Models whose provider emits real summaries (OpenAI\'s own) do display.',
    },
  };

  function renderAgentDetails() {
    renderAgentDetail('claude-code', dom.claudeAgentCard);
    renderAgentDetail('codex', dom.codexAgentCard);
  }

  function renderAgentDetail(target, container) {
    if (!container) return;

    const meta = AGENT_META[target];
    const st = integrationStatuses.find(s => s.target === target);
    const activeId = st?.active ? st.modelId : undefined;
    const roster = agentRosters[target] || [];

    let statusBadge;
    let notes;

    if (!st) {
      statusBadge = '<span class="badge">⏳ Checking…</span>';
      notes = '';
    } else if (!st.installed) {
      statusBadge = '<span class="badge">⚪ Not detected</span>';
      notes = `<div class="agent-note">${st.detail ? escapeHtml(st.detail) : `${meta.name} was not found on this machine. Install it first, then come back here.`}</div>`;
    } else if (st.active) {
      statusBadge = '<span class="badge badge-free" style="background:rgba(63,185,80,0.18); border-color:var(--accent-green);">✅ Running on OpenRouter</span>';
      notes = `
        ${st.detail ? `<div class="agent-note">${escapeHtml(st.detail)}</div>` : ''}
        ${meta.caveat ? `<div class="agent-note">🧠 ${meta.caveat}</div>` : ''}
        <div class="agent-note">⚠️ Uninstalling Maestro does <b>not</b> undo this — VS Code runs no code on uninstall. Switch back to <b>${escapeHtml(meta.defaultLabel)}</b> first if you want ${escapeHtml(meta.name)} on its own provider.</div>
      `;
    } else {
      statusBadge = `<span class="badge">🔵 Running on its own model</span>`;
      notes = `
        ${st.detail ? `<div class="agent-note agent-warn">${escapeHtml(st.detail)}</div>` : ''}
        <div class="agent-note">${meta.how}</div>
        <ol class="agent-steps">${meta.steps.map(s => `<li>${s}</li>`).join('')}</ol>
      `;
    }

    const installed = st?.installed !== false;

    // Both agents read their config when they start, so a session that is
    // already open keeps answering as the old model. Without this banner that
    // looks exactly like "switching did nothing".
    const reloadBanner = pendingReload[target] ? `
      <div class="reload-banner">
        <div class="reload-banner-text">
          <b>Restart needed.</b> ${escapeHtml(meta.name)}'s config on disk is already updated, but a
          session that is <b>currently running keeps the model it started with</b> — that is why it can
          still answer as the old one. Reload the window, then start a new ${escapeHtml(meta.name)} session.
          A ${escapeHtml(meta.name)} CLI running in a terminal has to be restarted on its own.
        </div>
        <button class="btn btn-primary btn-sm" data-reload-window>⟳ Reload Window</button>
      </div>` : '';

    container.innerHTML = `
      ${reloadBanner}
      <div class="active-model-card agent-card agent-${target}">
        <div class="active-model-header">
          <div class="active-model-details">
            <span class="active-model-name">${meta.icon} ${meta.name}</span>
            ${st?.configPath ? `<div class="model-card-id" style="margin-top: var(--space-1);">${escapeHtml(st.configPath)}</div>` : ''}
          </div>
        </div>
        <div class="model-card-badges" style="margin-top: var(--space-2);">${statusBadge}</div>
        ${notes}
      </div>

      <div class="roster">
        <div class="roster-header">
          <span class="roster-title">Your models</span>
          <span class="roster-hint">${roster.length} saved · one runs at a time</span>
        </div>
        <div class="roster-list">
          ${roster.map(entry => renderRosterRow(target, entry, activeId, installed)).join('')}
          <div class="active-model-card card-default ${activeId ? '' : 'card-active'}"
               title="Put ${escapeHtml(meta.name)} back on its own provider — your list is kept">
            <div class="active-model-header">
              <div class="active-model-details">
                <span class="active-model-name">${escapeHtml(meta.defaultLabel)}</span>
                <span class="active-model-id">Default — Maestro's config is removed and the original settings restored</span>
              </div>
              <div class="card-actions">
                ${activeId
                  ? '<button class="btn btn-sm" data-agent-default-btn>Use default</button>'
                  : '<span class="card-state">✓ In use</span>'}
              </div>
            </div>
          </div>
        </div>
        ${roster.length === 0 ? `
          <div class="agent-note">
            Nothing saved yet — open <b>Browse</b> and press <b>${meta.icon} ＋ ${escapeHtml(meta.name)}</b> on any model card.
          </div>` : ''}
      </div>
    `;

    bindRosterEvents(target, container);
  }

  function renderRosterRow(target, entry, activeId, installed) {
    const isActive = entry.id === activeId;
    const meta = AGENT_META[target];
    const id = escapeHtml(entry.id);

    const actions = `
      ${isActive
        ? '<span class="card-state">✓ Active</span>'
        : `<button class="btn btn-primary btn-sm" data-activate="${id}" ${installed ? '' : 'disabled'}>Activate</button>`}
      <button class="btn btn-danger btn-sm" data-remove="${id}">Remove from ${escapeHtml(meta.name)}</button>
    `;

    return renderAgentModelCard({
      id: entry.id,
      name: entry.name,
      actions,
      extraClass: isActive ? 'card-active' : '',
    });
  }

  function bindRosterEvents(target, container) {
    const reloadBtn = container.querySelector('[data-reload-window]');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'reloadWindow' }));
    }

    container.querySelectorAll('[data-activate]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscodeApi.postMessage({
          type: 'activateAgentModel',
          target,
          modelId: e.currentTarget.dataset.activate,
        });
      });
    });

    container.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscodeApi.postMessage({
          type: 'removeFromAgent',
          target,
          modelId: e.currentTarget.dataset.remove,
        });
      });
    });

    const defaultBtn = container.querySelector('[data-agent-default-btn]');
    if (defaultBtn) {
      defaultBtn.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'deactivateAgent', target });
      });
    }
  }

  function renderEmptyState() {
    if (!hasApiKey) {
      return `
        <div class="empty-state">
          <div class="empty-state-icon">🔑</div>
          <div class="empty-state-title">Set Your API Key</div>
          <div class="empty-state-desc">Enter your OpenRouter API key to start browsing models. Click the key icon above or the button below.</div>
          <button class="btn btn-primary" onclick="vscodeApi.postMessage({type:'setApiKey'})">🔑 Set API Key</button>
        </div>
      `;
    }
    return `
      <div class="empty-state">
        <div class="empty-state-icon">🔄</div>
        <div class="empty-state-title">No Models Loaded</div>
        <div class="empty-state-desc">Click the sync button to fetch available models from OpenRouter.</div>
        <button class="btn btn-primary" onclick="vscodeApi.postMessage({type:'syncModels'})">🔄 Sync Models</button>
      </div>
    `;
  }

  function renderNoResults() {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">No Matching Models</div>
        <div class="empty-state-desc">Try adjusting your search or filters.</div>
        <button class="btn" onclick="resetFilters()">Clear Filters</button>
      </div>
    `;
  }

  function renderProviderDropdown() {
    const providers = [...new Set(allModels.map(m => m.provider))].sort();
    dom.providerMenu.innerHTML = `
      <div class="provider-option ${!Filters.get().provider ? 'selected' : ''}" data-provider="">All Providers</div>
      ${providers.map(p => `
        <div class="provider-option ${Filters.get().provider === p ? 'selected' : ''}" data-provider="${p}">${p}</div>
      `).join('')}
    `;

    dom.providerMenu.querySelectorAll('.provider-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        const provider = e.currentTarget.dataset.provider;
        Filters.set('provider', provider);
        dom.providerBtn.textContent = provider || '🏢 Provider';
        dom.providerMenu.classList.remove('open');
        renderModels();
        dom.providerMenu.querySelectorAll('.provider-option').forEach(o => o.classList.remove('selected'));
        e.currentTarget.classList.add('selected');
      });
    });
  }

  // ===== UI HELPERS =====
  function setLoading(loading) {
    isLoading = loading;
    dom.loadingOverlay.classList.toggle('visible', loading);
  }

  function updateApiKeyUI() {
    if (dom.apiKeyBanner) {
      dom.apiKeyBanner.style.display = hasApiKey ? 'none' : 'flex';
    }
  }

  function updateStats(total) {
    dom.statsCount.textContent = total || allModels.length;
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function formatTokenCount(count) {
    if (!count || count === 0) return 'N/A';
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(0)}K`;
    return count.toString();
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ===== GLOBAL FUNCTIONS =====
  window.removeModel = function(modelId) {
    vscodeApi.postMessage({ type: 'removeModel', modelId });
  };

  window.removeActiveModel = function(modelId) {
    vscodeApi.postMessage({ type: 'removeActiveModel', modelId });
  };

  window.resetFilters = function() {
    Filters.reset();
    dom.searchInput.value = '';
    dom.searchClear.classList.remove('visible');
    dom.filterVision.classList.remove('active');
    dom.filterTools.classList.remove('active');
    dom.filterFree.classList.remove('active');
    dom.sortSelect.value = 'name-asc';
    dom.providerBtn.textContent = '🏢 Provider';
    renderModels();
  };

  // ===== BOOT =====
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
