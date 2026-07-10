/**
 * AI-Gateway-Hub web UI controller (Alpine.js).
 *
 * V1 scope:
 *   - Top bar (theme toggle, language placeholder, user)
 *   - Sidebar nav (8 items, 2 groups, collapsible)
 *   - Dashboard page (8 stat cards + model chart + provider distribution + recent requests)
 *   - Other tabs: "coming soon" placeholders
 */

function app() {
    return {
        // ─── State ────────────────────────────────────────────────────
        sidebarCollapsed: false,
        activeTab: 'dashboard',
        darkMode: document.documentElement.classList.contains('dark'),

        // Theme menu (B4): multiple presets, persisted to localStorage as 'agh-theme-id'
        themeId: localStorage.getItem('agh-theme-id') || (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
        themeMenuOpen: false,
        themeOptions: [
            { id: 'light',  name: '浅色',   icon: '☀️', dark: false, accent: '#3b82f6' },
            { id: 'dark',   name: '深色',   icon: '🌙', dark: true,  accent: '#3b82f6' },
            { id: 'auto',   name: '跟随系统', icon: '🖥', dark: null,  accent: '#3b82f6' },
            { id: 'ocean',  name: '海洋蓝',  icon: '🌊', dark: true,  accent: '#06b6d4' },
            { id: 'forest', name: '森林绿',  icon: '🌲', dark: true,  accent: '#10b981' },
            { id: 'sunset', name: '日落紫',  icon: '🌇', dark: true,  accent: '#a855f7' },
            { id: 'sepia',  name: '暖纸黄',  icon: '📜', dark: false, accent: '#b45309' }
        ],

        // Live clock (B4)
        nowText: '',
        _clockTimer: null,

        navConsole: [
            { id: 'dashboard',    label: 'navDashboard',    icon: '📊' },
            { id: 'requestLogs',  label: 'navRequestLogs',  icon: '📜' },
            { id: 'apiConfig',    label: 'navApiConfig',    icon: '🔌' },
            { id: 'chat',         label: 'navChat',         icon: '💬' },
            { id: 'usage',        label: 'navUsage',        icon: '📈' },
            { id: 'pricing',      label: 'navPricing',      icon: '💰' },
        ],
        navSystem: [
            { id: 'sysLogs',      label: 'navSysLogs',      icon: '📝' },
            { id: 'settings',     label: 'navSettings',     icon: '⚙️' },
        ],

        dashboard: {
            todayRequests: 0,
            todayTokens: 0,
            todayCost: 0,
            todayInput: 0, todayOutput: 0, todayCacheRead: 0, todayCacheCreate: 0, todayErrors: 0,
            avgRpm: 0,
            monthRequests: 0,
            monthTokens: 0,
            monthCost: 0,
            monthInput: 0, monthOutput: 0, monthCacheRead: 0, monthCacheCreate: 0, monthErrors: 0,
            avgTpm: 0,
            providerRows: [],
            recent: []
        },

        modelChartTab: 'cost',
        dashModelRange: '7d',         // '1d' | '3d' | '7d' | '30d' — for dashboard model chart
        _charts: {},   // canvas → Chart instance

        // ─── Usage analytics state (B3) ───────────────────────────────
        usageRange: '7d',                  // '1d' | '3d' | '7d' | '30d' | '12m'
        usageChartTab: 'requests',         // 'requests' | 'tokens' | 'cost'
        usageGranularity: 'day',
        usageTotals: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0, errors: 0 },
        usageTrend: [],
        usageProviders: [],                // [{ name, requests, ... }]
        usageModels: [],                   // [{ name, requests, ... }]
        usageLoading: false,

        // ─── Pricing state (B3) ───────────────────────────────────────
        pricingItems: [],
        pricingFilter: '',
        pricingLoading: false,
        pricingModal: {
            open: false,
            isNew: false,
            form: { provider: '', model: '', input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
        },

        // ─── Request logs state (B3) ──────────────────────────────────
        rlFilters: { dateFrom: '', dateTo: '', provider: '', model: '', q: '', success: 'any' },
        rlEntries: [],
        rlTotal: 0,
        rlSummary: null,
        rlPage: 0,
        rlPageSize: 50,
        rlLoading: false,
        rlDrawerOpen: false,
        rlDrawerEntry: null,

        // Custom date picker (B4 — replaces browser-locale-bound <input type=date>)
        datePicker: {
            field: null,        // 'dateFrom' | 'dateTo' | null
            year: 0,
            month: 0,           // 0-11
        },

        // ─── System logs state (B3) ───────────────────────────────────
        sysLogs: [],
        sysLogLevel: 'all',                // 'all'|'INFO'|'WARN'|'ERROR'|'SUCCESS'|'DEBUG'
        sysLogAutoScroll: true,
        _sysLogStream: null,

        // ─── Chat test state (B3) ─────────────────────────────────────
        chatMappings: [],
        chatSelectedMapping: '',
        chatSelectedModel: '',
        chatModelOptions: [],
        chatPrompt: '你好，请用一句话介绍你自己。',
        chatStreaming: false,
        chatMessages: [],                  // [{ role, content, timestamp, meta }]
        chatTemperature: 0.7,
        chatStream: true,
        _chatAbort: null,
        _chatHistoryKey: 'agh-chat-history',
        _chatHistoryMax: 100,

        // ─── Settings state (B4) ──────────────────────────────────────
        settings: {
            host: '', port: 0, configDir: '',
            logging: { enabled: true, retentionDays: 365 },
            theme: 'auto',
            bedrockOptimizer: { enabled: true, thinking: true, cacheInjection: true, cacheTtl: '1h' }
        },
        settingsLoading: false,
        settingsSaving: false,
        // Network listening + firewall (Tier 2 firewall automation)
        network: { host: '', port: 0, firewall: { state: 'unknown', raw: '', command: '', removeCommand: '' } },
        _origHost: '',
        hostSaving: false,
        get hostDirty() {
            return !!this._origHost && this.settings.host && this.settings.host !== this._origHost;
        },

        // ─── Translation helper ───────────────────────────────────────
        tt(key) {
            return (window.t && window.t(key)) || key;
        },

        tabLabel(tab) {
            const map = {
                requestLogs: 'navRequestLogs', apiConfig: 'navApiConfig',
                chat: 'navChat', usage: 'navUsage', pricing: 'navPricing',
                sysLogs: 'navSysLogs', settings: 'navSettings'
            };
            return this.tt(map[tab] || tab);
        },

        // ─── Lifecycle ────────────────────────────────────────────────
        async init() {
            try {
                const saved = localStorage.getItem('agh-sidebar');
                if (saved === 'collapsed') this.sidebarCollapsed = true;
                this.$watch('sidebarCollapsed', v => {
                    localStorage.setItem('agh-sidebar', v ? 'collapsed' : 'expanded');
                });

                this.$watch('darkMode', () => { this._updateAllCharts(); });

                // Apply persisted theme preset (defaults already set during state init)
                this.setTheme(this.themeId);

                // Restore chat history from localStorage
                this._loadChatHistory();

                // Live clock + countdown ticker
                this._tickClock();
                this._now = Date.now();
                this._clockTimer = setInterval(() => { this._tickClock(); this._now = Date.now(); }, 1000);

                // Defer dashboard load until Chart.js is ready
                this._waitForChart().then(() => this.loadDashboard()).catch(err => {
                    console.error('[init] dashboard load failed:', err);
                });

                // Pre-load providers (needed by mappings dropdowns across views)
                this.loadProviders();
            } catch (err) {
                console.error('[init] error:', err);
            }
        },

        _waitForChart() {
            return new Promise((resolve) => {
                if (window.Chart) return resolve();
                let tries = 0;
                const t = setInterval(() => {
                    if (window.Chart || tries++ > 50) {
                        clearInterval(t);
                        resolve();
                    }
                }, 100);
            });
        },

        // ─── UI helpers ───────────────────────────────────────────────
        setTab(id) {
            this.activeTab = id;
            if (id === 'dashboard') {
                // Re-render charts after the dashboard DOM becomes visible
                // (canvas size is 0 while x-show=false; Chart.js can't lay out)
                this.$nextTick(() => this._renderAllCharts());
            } else if (id === 'usage') {
                this.loadUsage();
            } else if (id === 'pricing') {
                this.loadPricing();
            } else if (id === 'requestLogs') {
                this.loadRequestLogs();
            } else if (id === 'sysLogs') {
                this.startSysLogStream();
            } else if (id === 'chat') {
                this.loadChatTest();
            } else if (id === 'settings') {
                this.loadSettings();
            } else if (id === 'apiConfig') {
                this._loadApiConfig();
            }

            if (id !== 'sysLogs') this.stopSysLogStream();
        },

        toggleTheme() { this.setTheme(this.darkMode ? 'light' : 'dark'); },

        setTheme(id) {
            const opt = this.themeOptions.find(o => o.id === id) || this.themeOptions[0];
            this.themeId = opt.id;
            const root = document.documentElement;
            // Remove any prior theme-* class
            root.classList.forEach(cls => { if (cls.startsWith('theme-')) root.classList.remove(cls); });
            root.classList.add('theme-' + opt.id);

            let isDark;
            if (opt.dark === null) {
                isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            } else {
                isDark = !!opt.dark;
            }
            this.darkMode = isDark;
            if (isDark) root.classList.add('dark'); else root.classList.remove('dark');
            root.style.setProperty('--c-primary', opt.accent);
            localStorage.setItem('agh-theme-id', opt.id);
        },

        refreshCurrentTab() {
            const id = this.activeTab;
            if (id === 'dashboard') this.loadDashboard();
            else if (id === 'usage') this.loadUsage();
            else if (id === 'pricing') this.loadPricing();
            else if (id === 'requestLogs') this.loadRequestLogs();
            else if (id === 'sysLogs') { this.stopSysLogStream(); this.startSysLogStream(); }
            // Chat: only refresh mappings list — DO NOT touch chatMessages
            else if (id === 'chat') this.loadChatMappings();
            else if (id === 'apiConfig') { this._loadApiConfig(); }
            else if (id === 'settings') this.loadSettings?.();
        },

        async _loadApiConfig() {
            await Promise.all([this.loadProviders(), this.loadMappings()]);
            this.$nextTick(() => { this.providers = [...this.providers]; });
        },

        _tickClock() {
            const d = new Date();
            const pad = n => String(n).padStart(2, '0');
            this.nowText = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        },

        greeting() {
            const h = new Date().getHours();
            if (h < 6)  return this.tt('greetingNight');
            if (h < 12) return this.tt('greetingMorning');
            if (h < 18) return this.tt('greetingAfternoon');
            return this.tt('greetingEvening');
        },

        formatTime(iso) {
            if (!iso) return '';
            const d = new Date(iso);
            return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
        },

        // Number/money/string formatting helpers used by templates.
        // Defined here (not inline in HTML) so Alpine never sees raw `?.` or
        // method chains on possibly-undefined values.
        formatInt(n) {
            const v = Number(n) || 0;
            return v.toLocaleString();
        },
        formatFloat(n) {
            const v = Number(n) || 0;
            return v.toFixed(2);
        },
        formatMoney(n) {
            const v = Number(n) || 0;
            return '$' + v.toFixed(4);
        },
        cacheHitRatePct(row) {
            const input = Number(row?.inputTokens ?? row?.totalInputTokens ?? 0) || 0;
            const cached = Number(row?.cacheReadTokens ?? row?.totalCacheReadTokens ?? 0) || 0;
            const total = row?.provider === 'openai' ? input : input + cached;
            if (total <= 0) return '0.00%';
            return ((cached / total) * 100).toFixed(2) + '%';
        },
        distBarStyle(row) {
            const pct = row && typeof row.pct === 'number' ? row.pct : 0;
            const color = row && row.color ? row.color : '#3b82f6';
            return `width:${pct}%; background:${color}`;
        },
        toastClass(type) { return 'toast-' + (type || 'info'); },
        toastIcon(type) {
            if (type === 'success') return '✓';
            if (type === 'error') return '✕';
            if (type === 'warn') return '⚠';
            return 'ℹ';
        },
        mappingMeta(m) {
            const rules = (m && m.rules) ? m.rules.length : 0;
            const strat = this.strategyLabel(m && m.strategy);
            return `${rules} 条规则 · ${strat}`;
        },
        mappingTypeDesc(m) {
            return this.mappingTypeDescOf(m && m.type);
        },
        mappingTypeDescOf(type) {
            return type === 'openai'
                ? this.tt('mappingTypeOpenAIDesc')
                : this.tt('mappingTypeAnthropicDesc');
        },
        strategyLabel(s) {
            if (s === 'random') return this.tt('strategyRandom');
            if (s === 'least-used') return this.tt('strategyLeastUsed');
            if (s === 'sequential') return this.tt('strategySequential');
            if (s === 'time-window') return this.tt('strategyTimeWindow');
            return this.tt('strategyFixed');
        },
        openaiSnippet() {
            return `export OPENAI_BASE_URL=${this.forwardUrl()}/v1\nexport OPENAI_API_KEY=<映射关系里的 sk>`;
        },
        anthropicSnippet() {
            return `export ANTHROPIC_BASE_URL=${this.forwardUrl()}\nexport ANTHROPIC_API_KEY=<映射关系里的 sk>`;
        },

        // ─── Dashboard data ───────────────────────────────────────────
        async loadDashboard() {
            try {
                const [overviewRes, monthlyRes, providersRes, modelRangeRes, hourlyRes, minutelyRes, recentRes] = await Promise.all([
                    fetch('/api/usage/overview').then(r => r.json()),
                    fetch('/api/usage/monthly?months=1').then(r => r.json()),
                    fetch('/api/usage/providers').then(r => r.json()),
                    fetch(`/api/usage/range?range=${this.dashModelRange}`).then(r => r.json()),
                    fetch('/api/usage/buckets?granularity=hour&hours=24').then(r => r.json()),
                    fetch('/api/usage/buckets?granularity=minute&minutes=60').then(r => r.json()),
                    fetch('/api/usage/history?limit=20').then(r => r.json())
                ]);

                const today = overviewRes.today || {};
                const monthRow = (monthlyRes.data || []).slice(-1)[0] || {};

                this.dashboard.todayRequests = today.requests || 0;
                this.dashboard.todayTokens = (today.inputTokens || 0) + (today.outputTokens || 0);
                this.dashboard.todayCost = today.cost || 0;
                this.dashboard.todayInput = today.inputTokens || 0;
                this.dashboard.todayOutput = today.outputTokens || 0;
                this.dashboard.todayCacheRead = today.cacheReadTokens || 0;
                this.dashboard.todayCacheCreate = today.cacheCreateTokens || 0;
                this.dashboard.todayErrors = today.errors || 0;
                this.dashboard.monthRequests = monthRow.requests || 0;
                this.dashboard.monthTokens = (monthRow.inputTokens || 0) + (monthRow.outputTokens || 0);
                this.dashboard.monthCost = monthRow.cost || 0;
                this.dashboard.monthInput = monthRow.inputTokens || 0;
                this.dashboard.monthOutput = monthRow.outputTokens || 0;
                this.dashboard.monthCacheRead = monthRow.cacheReadTokens || 0;
                this.dashboard.monthCacheCreate = monthRow.cacheCreateTokens || 0;
                this.dashboard.monthErrors = monthRow.errors || 0;

                // RPM = total requests in last 60 minutes / 60
                const recentMinutes = minutelyRes.buckets || [];
                const reqs60 = recentMinutes.reduce((a, b) => a + (b.requests || 0), 0);
                const tok60 = recentMinutes.reduce((a, b) => a + (b.inputTokens || 0) + (b.outputTokens || 0), 0);
                this.dashboard.avgRpm = reqs60 / 60;
                this.dashboard.avgTpm = tok60 / 60;

                // Provider distribution
                const byProvider = providersRes.byProvider || {};
                const totalReq = Object.values(byProvider).reduce((a, p) => a + (p.requests || 0), 0) || 1;
                const palette = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#f97316', '#eab308'];
                this.dashboard.providerRows = Object.entries(byProvider)
                    .sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0))
                    .slice(0, 8)
                    .map(([name, stat], i) => ({
                        name,
                        requests: stat.requests || 0,
                        pct: ((stat.requests || 0) / totalReq) * 100,
                        color: palette[i % palette.length]
                    }));

                // Recent
                this.dashboard.recent = (recentRes.entries || []).slice(0, 20);

                // Cache hourly buckets for mini charts; byModel scoped to selected range
                this._hourlyBuckets = hourlyRes.buckets || [];
                this._minutelyBuckets = minutelyRes.buckets || [];
                this._byModel = modelRangeRes.byModel || {};

                this.$nextTick(() => this._renderAllCharts());
            } catch (err) {
                console.error('[Dashboard] load failed', err);
            }
        },

        setModelChart(tab) {
            this.modelChartTab = tab;
            this.$nextTick(() => this._renderModelChart());
        },

        async setDashModelRange(r) {
            if (this.dashModelRange === r) return;
            this.dashModelRange = r;
            try {
                const data = await fetch(`/api/usage/range?range=${r}`).then(x => x.json());
                this._byModel = data.byModel || {};
                this.$nextTick(() => this._renderModelChart());
            } catch (err) {
                this.toast('error', this.tt('error'), err.message);
            }
        },

        get hasModelData() {
            return this._byModel && Object.keys(this._byModel).length > 0;
        },

        // Provider model count — always show "selected / max(selected, discovered)"
        // so it never reads as nonsense like "3 / 0" when discovery hasn't run.
        modelCountText(p) {
            const sel = (p.selectedModels || []).length;
            const dis = (p.discoveredModels || []).length;
            const total = Math.max(sel, dis);
            return `${sel} / ${total}`;
        },

        // ─── Chart rendering ──────────────────────────────────────────
        _renderAllCharts() {
            // Skip if data not yet loaded (avoids "ghost" canvas with wrong palette)
            if (!Array.isArray(this._hourlyBuckets) || !Array.isArray(this._minutelyBuckets)) return;
            this._renderMini('chTodayReq',  this._hourlyBuckets.map(b => b.requests || 0), '#f97316');
            this._renderMini('chTodayTok',  this._hourlyBuckets.map(b => (b.inputTokens || 0) + (b.outputTokens || 0)), '#8b5cf6');
            this._renderMini('chRpm',       this._minutelyBuckets.map(b => b.requests || 0), '#3b82f6');
            this._renderMini('chTodayCost', this._hourlyBuckets.map(b => b.cost || 0), '#10b981');
            this._renderModelChart();
        },

        _renderMini(refKey, values, color) {
            const canvas = this.$refs[refKey];
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            this._destroyChart(canvas);
            this._charts[refKey] = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: values.map((_, i) => i),
                    datasets: [{
                        data: values,
                        borderColor: color,
                        backgroundColor: this._hexToRgba(color, 0.15),
                        fill: true,
                        tension: 0.35,
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: { legend: { display: false }, tooltip: { enabled: false } },
                    scales: { x: { display: false }, y: { display: false } }
                }
            });
        },

        _renderModelChart() {
            const canvas = this.$refs.chModel;
            if (!canvas) return;
            const byModel = this._byModel || {};
            const entries = Object.entries(byModel).sort((a, b) => {
                if (this.modelChartTab === 'cost') return (b[1].cost || 0) - (a[1].cost || 0);
                return (b[1].requests || 0) - (a[1].requests || 0);
            }).slice(0, 10);

            // No data: destroy any prior chart and let the empty-state DOM show through
            if (!entries.length) {
                this._destroyChart(canvas);
                return;
            }

            const labels = entries.map(([k]) => k);
            let data, color, type;
            if (this.modelChartTab === 'cost') {
                data = entries.map(([, v]) => v.cost || 0);
                color = '#eab308';
                type = 'bar';
            } else if (this.modelChartTab === 'count') {
                data = entries.map(([, v]) => v.requests || 0);
                color = '#3b82f6';
                type = 'doughnut';
            } else {
                data = entries.map(([, v]) => v.requests || 0);
                color = '#8b5cf6';
                type = 'bar';
            }

            const ctx = canvas.getContext('2d');
            this._destroyChart(canvas);

            const isDoughnut = type === 'doughnut';
            const palette = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ec4899','#06b6d4','#f97316','#eab308','#ef4444','#22d3ee'];

            this._charts.chModel = new Chart(ctx, {
                type,
                data: {
                    labels,
                    datasets: [{
                        label: this.modelChartTab === 'cost' ? '$' : '次',
                        data,
                        backgroundColor: isDoughnut ? palette : color,
                        borderColor: isDoughnut ? palette : color,
                        borderWidth: 1,
                        ...(this.modelChartTab === 'rank' ? { indexAxis: 'y' } : {})
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,        // V6: kill flicker when switching chart-type tabs
                    plugins: {
                        legend: isDoughnut ? { position: 'right', labels: { color: this._textColor() } } : { display: true, labels: { color: this._textColor() } }
                    },
                    scales: isDoughnut ? {} : {
                        x: { ticks: { color: this._mutedColor() }, grid: { color: this._gridColor() } },
                        y: { ticks: { color: this._mutedColor() }, grid: { color: this._gridColor() } }
                    },
                    indexAxis: this.modelChartTab === 'rank' ? 'y' : 'x'
                }
            });
        },

        _updateAllCharts() {
            // Theme changed — re-render
            this.$nextTick(() => this._renderAllCharts());
        },

        _destroyChart(canvas) {
            const existing = Chart.getChart && Chart.getChart(canvas);
            if (existing) existing.destroy();
        },

        _hexToRgba(hex, alpha) {
            const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
            if (!m) return hex;
            const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
            return `rgba(${r},${g},${b},${alpha})`;
        },

        _textColor() {
            return this.darkMode ? '#e5e7eb' : '#1f2937';
        },
        _mutedColor() {
            return this.darkMode ? '#94a3b8' : '#6b7280';
        },
        _gridColor() {
            return this.darkMode ? 'rgba(148,163,184,0.1)' : 'rgba(0,0,0,0.05)';
        },

        // ════════════════════════════════════════════════════════════════════
        // B3: 用量分析
        // ════════════════════════════════════════════════════════════════════

        async loadUsage() {
            this.usageLoading = true;
            try {
                const res = await fetch(`/api/usage/range?range=${this.usageRange}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                this.usageGranularity = data.granularity;
                this.usageTotals = data.totals || { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0, errors: 0 };
                this.usageTrend = Array.isArray(data.trend) ? data.trend : [];
                this.usageProviders = Object.entries(data.byProvider || {})
                    .map(([name, v]) => ({ name, ...v }))
                    .sort((a, b) => b.requests - a.requests);
                this.usageModels = Object.entries(data.byModel || {})
                    .map(([name, v]) => ({ name, ...v }))
                    .sort((a, b) => b.cost - a.cost);
                this.$nextTick(() => this._renderUsageTrendChart());
            } catch (err) {
                console.error('[loadUsage] failed:', err);
                this.toast && this.toast('error', this.tt('error'), err.message);
            } finally {
                this.usageLoading = false;
            }
        },

        setUsageRange(r) {
            if (this.usageRange === r) return;
            this.usageRange = r;
            this.loadUsage();
        },

        setUsageChartTab(tab) {
            if (this.usageChartTab === tab) return;
            this.usageChartTab = tab;
            this.$nextTick(() => this._renderUsageTrendChart());
        },

        usageErrorRatePct() {
            const r = this.usageTotals.requests || 0;
            if (!r) return '0.00%';
            return ((this.usageTotals.errors / r) * 100).toFixed(2) + '%';
        },

        rowErrorRatePct(row) {
            const r = row.requests || 0;
            if (!r) return '0.00%';
            return ((row.errors / r) * 100).toFixed(2) + '%';
        },

        rowSharePct(row, key) {
            const total = key === 'cost' ? this.usageTotals.cost : this.usageTotals.requests;
            const v = key === 'cost' ? (row.cost || 0) : (row.requests || 0);
            if (!total) return 0;
            return Math.min(100, (v / total) * 100);
        },

        _renderUsageTrendChart() {
            const canvas = this.$refs.chUsageTrend;
            if (!canvas) return;
            if (!Array.isArray(this.usageTrend) || !this.usageTrend.length) {
                this._destroyChart(canvas);
                return;
            }
            const labels = this.usageTrend.map(b => b.key);
            let values, color, label;
            if (this.usageChartTab === 'cost') {
                values = this.usageTrend.map(b => b.cost || 0);
                color = '#10b981';
                label = '$';
            } else if (this.usageChartTab === 'tokens') {
                values = this.usageTrend.map(b => (b.inputTokens || 0) + (b.outputTokens || 0));
                color = '#8b5cf6';
                label = 'Token';
            } else {
                values = this.usageTrend.map(b => b.requests || 0);
                color = '#3b82f6';
                label = '次';
            }

            const ctx = canvas.getContext('2d');
            this._destroyChart(canvas);
            this._charts.chUsageTrend = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        label,
                        data: values,
                        borderColor: color,
                        backgroundColor: this._hexToRgba(color, 0.15),
                        fill: true,
                        tension: 0.3,
                        borderWidth: 2,
                        pointRadius: 2,
                        pointHoverRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: { mode: 'index', intersect: false }
                    },
                    scales: {
                        x: {
                            ticks: { color: this._mutedColor(), maxRotation: 0, autoSkipPadding: 16 },
                            grid: { color: this._gridColor() }
                        },
                        y: {
                            ticks: { color: this._mutedColor() },
                            grid: { color: this._gridColor() },
                            beginAtZero: true
                        }
                    }
                }
            });
        },

        // ════════════════════════════════════════════════════════════════════
        // B3: 价格管理
        // ════════════════════════════════════════════════════════════════════

        async loadPricing() {
            this.pricingLoading = true;
            try {
                const res = await fetch('/api/pricing');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                this.pricingItems = data.items || [];
            } catch (err) {
                console.error('[loadPricing]', err);
                this.toast && this.toast('error', this.tt('error'), err.message);
            } finally {
                this.pricingLoading = false;
            }
        },

        get filteredPricing() {
            const q = (this.pricingFilter || '').toLowerCase().trim();
            if (!q) return this.pricingItems;
            return this.pricingItems.filter(it =>
                (it.provider || '').toLowerCase().includes(q) ||
                (it.model || '').toLowerCase().includes(q));
        },

        openPricingEdit(item) {
            this.pricingModal = {
                open: true,
                isNew: false,
                form: {
                    provider: item.provider,
                    model: item.model,
                    input: item.input,
                    output: item.output,
                    cacheRead: item.cacheRead,
                    cacheCreate: item.cacheCreate
                }
            };
        },

        openPricingAdd() {
            this.pricingModal = {
                open: true,
                isNew: true,
                form: { provider: 'openai', model: '', input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
            };
        },

        closePricingModal() { this.pricingModal.open = false; },

        async submitPricingModal() {
            const f = this.pricingModal.form;
            const provider = (f.provider || '').trim();
            const model = (f.model || '').trim();
            if (!provider || !model) {
                this.toast('warn', this.tt('fieldRequired'), 'provider / model');
                return;
            }
            try {
                const res = await fetch(`/api/pricing/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        input: Number(f.input) || 0,
                        output: Number(f.output) || 0,
                        cacheRead: Number(f.cacheRead) || 0,
                        cacheCreate: Number(f.cacheCreate) || 0
                    })
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                this.closePricingModal();
                this.toast('success', this.tt('saved'));
                this.loadPricing();
            } catch (err) {
                this.toast('error', this.tt('error'), err.message);
            }
        },

        async resetPricingItem(item) {
            const ok = await this.confirmAsk(this.tt('pricingResetConfirm'));
            if (!ok) return;
            try {
                const res = await fetch(`/api/pricing/${encodeURIComponent(item.provider)}/${encodeURIComponent(item.model)}/reset`, {
                    method: 'POST'
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                this.toast('success', this.tt('saved'));
                this.loadPricing();
            } catch (err) {
                this.toast('error', this.tt('error'), err.message);
            }
        },

        // ════════════════════════════════════════════════════════════════════
        // B3: 使用日志
        // ════════════════════════════════════════════════════════════════════

        async loadRequestLogs() {
            this.rlLoading = true;
            try {
                const params = new URLSearchParams();
                params.set('limit', this.rlPageSize);
                params.set('offset', this.rlPage * this.rlPageSize);
                params.set('sort', '-timestamp');
                if (this.rlFilters.dateFrom) params.set('dateFrom', this.rlFilters.dateFrom);
                if (this.rlFilters.dateTo)   params.set('dateTo', this.rlFilters.dateTo);
                if (this.rlFilters.provider) params.set('provider', this.rlFilters.provider);
                if (this.rlFilters.model)    params.set('model', this.rlFilters.model);
                if (this.rlFilters.q)        params.set('q', this.rlFilters.q);
                if (this.rlFilters.success !== 'any') params.set('success', this.rlFilters.success);

                const [searchRes, summaryRes] = await Promise.all([
                    fetch(`/api/request-logs/search?${params.toString()}`).then(r => r.json()),
                    fetch(`/api/request-logs/summary?${params.toString()}`).then(r => r.json())
                ]);
                this.rlEntries = searchRes.entries || [];
                this.rlTotal = searchRes.total || 0;
                this.rlSummary = summaryRes;
            } catch (err) {
                this.toast('error', this.tt('error'), err.message);
            } finally {
                this.rlLoading = false;
            }
        },

        rlSetPage(p) {
            const max = this.rlPageMax;
            this.rlPage = Math.max(0, Math.min(max, p));
            this.loadRequestLogs();
        },

        rlApplyFilters() {
            this.rlPage = 0;
            this.loadRequestLogs();
        },

        rlClearFilters() {
            this.rlFilters = { dateFrom: '', dateTo: '', provider: '', model: '', q: '', success: 'any' };
            this.rlPage = 0;
            this.loadRequestLogs();
        },

        rlOpenDrawer(entry) {
            this.rlDrawerEntry = entry;
            this.rlDrawerOpen = true;
        },

        rlCloseDrawer() {
            this.rlDrawerOpen = false;
            setTimeout(() => { this.rlDrawerEntry = null; }, 200);
        },

        rlExport(format) {
            const params = new URLSearchParams();
            params.set('format', format);
            if (this.rlFilters.dateFrom) params.set('dateFrom', this.rlFilters.dateFrom);
            if (this.rlFilters.dateTo)   params.set('dateTo', this.rlFilters.dateTo);
            if (this.rlFilters.provider) params.set('provider', this.rlFilters.provider);
            if (this.rlFilters.model)    params.set('model', this.rlFilters.model);
            if (this.rlFilters.q)        params.set('q', this.rlFilters.q);
            if (this.rlFilters.success !== 'any') params.set('success', this.rlFilters.success);
            window.open(`/api/request-logs/export?${params.toString()}`, '_blank');
        },

        rlPrettyJson(s) {
            if (!s) return '';
            try { return JSON.stringify(JSON.parse(s), null, 2); }
            catch { return String(s); }
        },

        rlReasoningLabel(e) {
            const requested = e?.requestedReasoningEffort || e?.reasoningEffort || e?.requestBodyReasoningEffort || '';
            const upstream = e?.upstreamReasoningEffort || '';
            if (requested && upstream && requested !== upstream) return `${requested} → ${upstream}`;
            return upstream || requested || '-';
        },

        rlProtocolLabel(route) {
            if (!route) return '-';
            if (route.includes('/chat/completions')) return 'Chat';
            if (route.includes('/responses')) return 'Resp';
            if (route.includes('/messages')) return 'Msg';
            return '-';
        },

        rlShortTime(iso) {
            if (!iso) return '';
            try { return new Date(iso).toLocaleString(); } catch { return iso; }
        },

        get rlPageCap() {
            // When no date-range filter is set, cap browsing at 10 pages to
            // prevent the UI from rendering huge result sets.
            return this.rlFilters.dateFrom ? 0 : 10;
        },

        get rlPageMax() {
            const natural = Math.max(0, Math.ceil(this.rlTotal / this.rlPageSize) - 1);
            const cap = this.rlPageCap;
            if (cap > 0) return Math.min(natural, cap - 1);
            return natural;
        },

        // ─── Custom date picker ───────────────────────────────────────
        openDatePicker(field) {
            const cur = this.rlFilters[field];
            let y, m;
            if (cur && /^\d{4}-\d{2}-\d{2}$/.test(cur)) {
                const [yy, mm] = cur.split('-').map(Number);
                y = yy; m = mm - 1;
            } else {
                const d = new Date();
                y = d.getFullYear(); m = d.getMonth();
            }
            this.datePicker = { field, year: y, month: m };
        },

        closeDatePicker() { this.datePicker.field = null; },

        dpPrevMonth() {
            let m = this.datePicker.month - 1;
            let y = this.datePicker.year;
            if (m < 0) { m = 11; y--; }
            this.datePicker.month = m;
            this.datePicker.year = y;
        },

        dpNextMonth() {
            let m = this.datePicker.month + 1;
            let y = this.datePicker.year;
            if (m > 11) { m = 0; y++; }
            this.datePicker.month = m;
            this.datePicker.year = y;
        },

        get dpWeeks() {
            // 6 rows × 7 cols of day cells starting Sunday
            const y = this.datePicker.year;
            const m = this.datePicker.month;
            const first = new Date(y, m, 1);
            const startDow = first.getDay();          // 0=Sun
            const daysInMonth = new Date(y, m + 1, 0).getDate();
            const today = new Date();
            const todayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
            const selectedKey = this.datePicker.field ? this.rlFilters[this.datePicker.field] : '';

            const cells = [];
            // Leading blanks for days before the 1st
            for (let i = 0; i < startDow; i++) cells.push(null);
            for (let d = 1; d <= daysInMonth; d++) {
                const key = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                cells.push({
                    day: d,
                    key,
                    isToday: key === todayKey,
                    isSelected: key === selectedKey
                });
            }
            // Trailing blanks to fill last row
            while (cells.length % 7 !== 0) cells.push(null);
            const weeks = [];
            for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
            return weeks;
        },

        dpMonthLabel() {
            return `${this.datePicker.year} 年 ${this.datePicker.month + 1} 月`;
        },

        dpPickDay(cell) {
            if (!cell) return;
            const field = this.datePicker.field;
            this.rlFilters[field] = cell.key;
            this.closeDatePicker();
            this.rlApplyFilters();
        },

        dpClear() {
            const field = this.datePicker.field;
            if (field) {
                this.rlFilters[field] = '';
                this.closeDatePicker();
                this.rlApplyFilters();
            }
        },

        dpToday() {
            const d = new Date();
            const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            const field = this.datePicker.field;
            this.rlFilters[field] = key;
            this.closeDatePicker();
            this.rlApplyFilters();
        },

        // ════════════════════════════════════════════════════════════════════
        // B3: 系统日志
        // ════════════════════════════════════════════════════════════════════

        startSysLogStream() {
            if (this._sysLogStream) return;
            this.sysLogs = [];
            try {
                const es = new EventSource('/api/logs/stream?history=true');
                es.onmessage = (ev) => {
                    try {
                        const log = JSON.parse(ev.data);
                        this.sysLogs.push(log);
                        if (this.sysLogs.length > 2000) this.sysLogs = this.sysLogs.slice(-2000);
                        if (this.sysLogAutoScroll) {
                            this.$nextTick(() => {
                                const el = this.$refs.sysLogScroll;
                                if (el) el.scrollTop = el.scrollHeight;
                            });
                        }
                    } catch { /* skip bad frame */ }
                };
                es.onerror = () => { /* let browser auto-reconnect */ };
                this._sysLogStream = es;
            } catch (err) {
                this.toast('error', this.tt('error'), err.message);
            }
        },

        stopSysLogStream() {
            if (this._sysLogStream) {
                this._sysLogStream.close();
                this._sysLogStream = null;
            }
        },

        clearSysLogs() { this.sysLogs = []; },

        get filteredSysLogs() {
            if (this.sysLogLevel === 'all') return this.sysLogs;
            return this.sysLogs.filter(l => (l.level || '').toUpperCase() === this.sysLogLevel);
        },

        sysLogClass(level) {
            const lv = (level || '').toUpperCase();
            if (lv === 'ERROR') return 'log-line log-error';
            if (lv === 'WARN' || lv === 'WARNING') return 'log-line log-warn';
            if (lv === 'SUCCESS') return 'log-line log-success';
            if (lv === 'DEBUG') return 'log-line log-debug';
            return 'log-line log-info';
        },

        // ════════════════════════════════════════════════════════════════════
        // B3: 聊天测试
        // ════════════════════════════════════════════════════════════════════

        async loadChatTest() {
            await this.loadChatMappings();
        },

        async loadChatMappings() {
            try {
                const res = await fetch('/api/mappings');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                this.chatMappings = (data.mappings || []).filter(m => m.enabled !== false);
                if (!this.chatSelectedMapping && this.chatMappings.length) {
                    this.selectChatMapping(this.chatMappings[0].id);
                }
            } catch (err) {
                this.toast('error', this.tt('error'), err.message);
            }
        },

        _loadChatHistory() {
            try {
                const raw = localStorage.getItem(this._chatHistoryKey);
                if (!raw) return;
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) this.chatMessages = arr.slice(-this._chatHistoryMax);
            } catch { /* corrupt key — ignore */ }
        },

        _saveChatHistory() {
            try {
                // Keep latest N entries, drop streaming-meta to keep storage clean
                const trimmed = this.chatMessages
                    .slice(-this._chatHistoryMax)
                    .map(m => ({
                        role: m.role,
                        content: m.content,
                        timestamp: m.timestamp || new Date().toISOString(),
                        meta: m.meta && !m.meta.streaming ? m.meta : null
                    }));
                localStorage.setItem(this._chatHistoryKey, JSON.stringify(trimmed));
            } catch { /* quota exceeded — ignore */ }
        },

        formatChatTime(iso) {
            if (!iso) return '';
            try {
                const d = new Date(iso);
                const pad = n => String(n).padStart(2, '0');
                return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
            } catch { return ''; }
        },

        selectChatMapping(id) {
            this.chatSelectedMapping = id;
            const m = this.chatMappings.find(x => x.id === id);
            if (!m) { this.chatModelOptions = []; this.chatSelectedModel = ''; return; }
            const models = (m.rules || [])
                .filter(r => r.enabled !== false)
                .map(r => r.inputModel)
                .filter(Boolean);
            this.chatModelOptions = [...new Set(models)];
            this.chatSelectedModel = this.chatModelOptions[0] || '';
        },

        get currentChatMapping() {
            return this.chatMappings.find(m => m.id === this.chatSelectedMapping) || null;
        },

        async sendChat() {
            const mapping = this.currentChatMapping;
            if (!mapping) { this.toast('warn', '请选择映射'); return; }
            if (!this.chatSelectedModel) { this.toast('warn', '请选择模型'); return; }
            const prompt = (this.chatPrompt || '').trim();
            if (!prompt) return;

            this.chatMessages.push({ role: 'user', content: prompt, timestamp: new Date().toISOString() });
            this.chatMessages.push({ role: 'assistant', content: '', timestamp: new Date().toISOString(), meta: { streaming: true } });
            const placeholderIdx = this.chatMessages.length - 1;
            const setContent = (v) => { this.chatMessages[placeholderIdx].content = v; };
            const appendContent = (v) => { this.chatMessages[placeholderIdx].content += v; };
            const setMeta = (v) => { this.chatMessages[placeholderIdx].meta = v; this._saveChatHistory(); };

            this.chatStreaming = true;
            this.chatPrompt = '';
            this._saveChatHistory();      // persist immediately so user prompt + placeholder survive a reload mid-flight
            this.$nextTick(() => this._scrollChatToBottom());

            const isAnthropic = mapping.type === 'anthropic';
            const url = isAnthropic ? '/v1/messages' : '/v1/chat/completions';
            const headers = { 'Content-Type': 'application/json' };
            if (isAnthropic) {
                headers['x-api-key'] = mapping.localSk;
                headers['anthropic-version'] = '2023-06-01';
            } else {
                headers['Authorization'] = 'Bearer ' + mapping.localSk;
            }

            const body = isAnthropic ? {
                model: this.chatSelectedModel,
                max_tokens: 1024,
                stream: this.chatStream,
                messages: [{ role: 'user', content: prompt }]
            } : {
                model: this.chatSelectedModel,
                stream: this.chatStream,
                temperature: this.chatTemperature,
                messages: [{ role: 'user', content: prompt }]
            };

            const t0 = Date.now();
            const ctrl = new AbortController();
            this._chatAbort = ctrl;

            try {
                const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
                if (!res.ok) {
                    const text = await res.text();
                    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
                }
                if (!this.chatStream) {
                    const data = await res.json();
                    setContent(this._extractNonStream(data, isAnthropic));
                    setMeta({ streaming: false, durationMs: Date.now() - t0 });
                } else {
                    await this._consumeChatStream(res, appendContent, isAnthropic);
                    setMeta({ streaming: false, durationMs: Date.now() - t0 });
                }
            } catch (err) {
                appendContent(`\n\n[error] ${err.message}`);
                setMeta({ streaming: false, error: true });
            } finally {
                this.chatStreaming = false;
                this._chatAbort = null;
                this._saveChatHistory();
                this.$nextTick(() => this._scrollChatToBottom());
            }
        },

        async _consumeChatStream(res, appendContent, isAnthropic) {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (!data || data === '[DONE]') continue;
                    try {
                        const obj = JSON.parse(data);
                        if (isAnthropic) {
                            if (obj.type === 'content_block_delta' && obj.delta?.text) appendContent(obj.delta.text);
                        } else {
                            const delta = obj.choices?.[0]?.delta?.content;
                            if (delta) appendContent(delta);
                        }
                    } catch { /* ignore non-json frame */ }
                }
            }
        },

        _extractNonStream(data, isAnthropic) {
            if (isAnthropic) {
                return (data.content || []).map(c => c.text || '').join('');
            }
            return data.choices?.[0]?.message?.content || '';
        },

        cancelChat() {
            if (this._chatAbort) { try { this._chatAbort.abort(); } catch { } }
        },

        clearChat() {
            this.chatMessages = [];
            try { localStorage.removeItem(this._chatHistoryKey); } catch { /* ignore */ }
        },

        _scrollChatToBottom() {
            const el = this.$refs.chatHistory;
            if (el) el.scrollTop = el.scrollHeight;
        },

        // ════════════════════════════════════════════════════════════════════
        // B4: 系统设置
        // ════════════════════════════════════════════════════════════════════

        async loadSettings() {
            this.settingsLoading = true;
            try {
                const res = await fetch('/api/settings');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                this.settings = {
                    host: data.host || '',
                    port: data.port || 0,
                    configDir: data.configDir || '',
                    logging: {
                        enabled: data.logging?.enabled !== false,
                        retentionDays: data.logging?.retentionDays || 365
                    },
                    theme: data.theme || 'auto',
                    bedrockOptimizer: {
                        enabled: data.bedrockOptimizer?.enabled !== false,
                        thinking: data.bedrockOptimizer?.thinking !== false,
                        cacheInjection: data.bedrockOptimizer?.cacheInjection !== false,
                        cacheTtl: data.bedrockOptimizer?.cacheTtl || '1h'
                    }
                };
                this._origHost = data.host || '';
                this.loadNetworkStatus();
            } catch (err) {
                this.toast('error', this.tt('settingsLoadFail'), err.message);
            } finally {
                this.settingsLoading = false;
            }
        },

        async saveSettings() {
            this.settingsSaving = true;
            try {
                const days = Number(this.settings.logging.retentionDays) || 365;
                const body = {
                    logging: {
                        enabled: !!this.settings.logging.enabled,
                        retentionDays: Math.max(1, Math.min(3650, days))
                    },
                    theme: this.settings.theme,
                    bedrockOptimizer: {
                        enabled: !!this.settings.bedrockOptimizer.enabled,
                        thinking: !!this.settings.bedrockOptimizer.thinking,
                        cacheInjection: !!this.settings.bedrockOptimizer.cacheInjection,
                        cacheTtl: this.settings.bedrockOptimizer.cacheTtl || '1h'
                    }
                };
                const res = await fetch('/api/settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                this.settings.logging.retentionDays = data.logging.retentionDays;
                this.settings.bedrockOptimizer = data.bedrockOptimizer || this.settings.bedrockOptimizer;
                this.toast('success', this.tt('settingsSavedTip'));
            } catch (err) {
                this.toast('error', this.tt('error'), err.message);
            } finally {
                this.settingsSaving = false;
            }
        },

        exportBackup() {
            window.location.href = '/api/backup';
        },

        // ─── Tier 2 firewall automation ───────────────────────────────
        async loadNetworkStatus() {
            try {
                const res = await fetch('/api/settings/network');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                this.network = await res.json();
            } catch (err) {
                this.network = { host: '', port: 0, firewall: { state: 'unknown', raw: err.message, command: '', removeCommand: '' } };
            }
        },

        async saveHost() {
            if (!this.hostDirty) return;
            this.hostSaving = true;
            try {
                const res = await fetch('/api/settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ host: this.settings.host })
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                this._origHost = this.settings.host;
                this.toast('success', this.tt('settingsHostSaved'));
                // re-probe firewall (state changes when host flips to 0.0.0.0)
                this.loadNetworkStatus();
            } catch (err) {
                this.toast('error', this.tt('error'), err.message);
            } finally {
                this.hostSaving = false;
            }
        },

        async copyFirewallCommand(kind) {
            const cmd = kind === 'remove' ? this.network.firewall?.removeCommand : this.network.firewall?.command;
            if (!cmd) return;
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(cmd);
                } else {
                    // fallback for http:// contexts
                    const ta = document.createElement('textarea');
                    ta.value = cmd; ta.style.position = 'fixed'; ta.style.opacity = '0';
                    document.body.appendChild(ta); ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                }
                const tip = kind === 'remove' ? this.tt('settingsFirewallCopiedRemove') : this.tt('settingsFirewallCopiedAdd');
                this.toast('success', tip);
            } catch (err) {
                this.toast('error', this.tt('error'), err.message);
            }
        },

        async importBackup(event) {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!data._backup) { this.toast('error', this.tt('backupImportInvalid')); return; }
                const res = await fetch('/api/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: text
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const result = await res.json();
                this.toast('success', this.tt('backupImportSuccess') + result.restored.join(', '));
                setTimeout(() => location.reload(), 1500);
            } catch (err) {
                this.toast('error', this.tt('backupImportFail'), err.message);
            } finally {
                event.target.value = '';
            }
        },

        currentThemeName() {
            return this.themeOptions.find(o => o.id === this.themeId)?.name || this.themeId;
        },

        // ════════════════════════════════════════════════════════════════════
        // B2: API 配置 — providers / mappings / output endpoints
        // ════════════════════════════════════════════════════════════════════

        apiSubTab: 'input',
        providers: [],
        mappings: [],

        // ─── Toast ──────────────────────────────────────────────────────────
        toasts: [],
        _toastId: 0,
        toast(type, title, msg = '') {
            const id = ++this._toastId;
            this.toasts.push({ id, type, title, msg });
            setTimeout(() => {
                this.toasts = this.toasts.filter(t => t.id !== id);
            }, 3000);
        },

        // ─── Confirm dialog ────────────────────────────────────────────────
        confirmDlg: { open: false, message: '', _resolve: null },
        confirmAsk(message) {
            return new Promise(resolve => {
                this.confirmDlg = { open: true, message, _resolve: resolve };
            });
        },
        confirmAccept() {
            const r = this.confirmDlg._resolve;
            this.confirmDlg = { open: false, message: '', _resolve: null };
            if (r) r(true);
        },
        closeConfirm() {
            const r = this.confirmDlg._resolve;
            this.confirmDlg = { open: false, message: '', _resolve: null };
            if (r) r(false);
        },

        // ─── Generic API helper ────────────────────────────────────────────
        async _api(method, url, body) {
            try {
                const opts = { method, headers: {} };
                if (body !== undefined) {
                    opts.headers['Content-Type'] = 'application/json';
                    opts.body = JSON.stringify(body);
                }
                const r = await fetch(url, opts);
                const ct = r.headers.get('content-type') || '';
                const data = ct.includes('application/json') ? await r.json() : await r.text();
                return { ok: r.ok, status: r.status, data };
            } catch (err) {
                return { ok: false, status: 0, data: { error: err.message } };
            }
        },

        // ─── Helpers ───────────────────────────────────────────────────────
        capitalize(s) { return (s || '').charAt(0).toUpperCase() + (s || '').slice(1); },
        forwardUrl() {
            const port = location.port || '44559';
            return `${location.protocol}//${location.hostname}:${port}`;
        },
        maskSk(sk) {
            if (!sk) return '';
            if (sk.length <= 10) return '****';
            return sk.slice(0, 6) + '…' + sk.slice(-4);
        },
        async copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                this.toast('success', this.tt('copied'));
            } catch {
                this.toast('error', this.tt('error'), '复制失败');
            }
        },
        providersByType(type) {
            return (this.providers || []).filter(p => p.type === type);
        },
        selectedModelsOf(providerId) {
            const p = (this.providers || []).find(x => x.id === providerId);
            return p ? (p.selectedModels || []) : [];
        },

        // ─── Load lists ────────────────────────────────────────────────────
        async loadProviders() {
            const r = await this._api('GET', '/api/providers');
            if (r.ok && r.data) {
                this.providers = r.data.providers || [];
                // Force mapping templates to re-render with new providers data
                // (selects inside mapping rules depend on providers; without
                //  fresh DOM the browser caches selectedIndex=0)
                if (this.mappings && this.mappings.length > 0) {
                    this.mappings = this.mappings.map(m => ({ ...m }));
                }
            } else {
                this.toast('error', this.tt('error'), r.data?.error || '加载失败');
            }
        },
        async loadMappings() {
            const r = await this._api('GET', '/api/mappings');
            if (r.ok && r.data) {
                const oldMap = {};
                for (const m of this.mappings) oldMap[m.id] = m;
                this.mappings = (r.data.mappings || []).map(m => ({
                    ...m,
                    _open: oldMap[m.id]?._open || false,
                    _showSk: oldMap[m.id]?._showSk || false
                }));
            } else {
                this.toast('error', this.tt('error'), r.data?.error || '加载失败');
            }
        },

        // ─── Provider Modal ────────────────────────────────────────────────
        providerModal: {
            open: false,
            editing: null,
            type: 'openai',
            form: { id: '', type: 'openai', name: '', baseUrl: '', apiKey: '', selectedModels: [], discoveredModels: [], supportsNativeResponses: false },
            modelHealthStatus: {}  // { modelName: { ok: true, status: 'healthy', responseTime: 123 } }
        },

        openProviderModal(type, editing = null) {
            this.providerModal = {
                open: true,
                editing,
                type: editing ? editing.type : type,
                modelHealthStatus: {},  // 重置健康状态
                form: editing
                    ? {
                        id: editing.id,
                        type: editing.type,
                        name: editing.name || '',
                        baseUrl: editing.baseUrl || '',
                        apiKey: '',   // keep blank for safety; server preserves existing if blank
                        selectedModels: [...(editing.selectedModels || [])],
                        discoveredModels: [...(editing.discoveredModels || [])],
                        supportsNativeResponses: !!editing.supportsNativeResponses
                    }
                    : {
                        id: '', type, name: '', baseUrl: '', apiKey: '',
                        selectedModels: [], discoveredModels: [],
                        supportsNativeResponses: false
                    }
            };
        },

        closeProviderModal() {
            this.providerModal.open = false;
        },

        toggleModelInModal(model) {
            const arr = this.providerModal.form.selectedModels || [];
            const i = arr.indexOf(model);
            if (i >= 0) arr.splice(i, 1);
            else arr.push(model);
            this.providerModal.form.selectedModels = [...arr];
        },

        async discoverInModal() {
            const id = this.providerModal.form.id;
            if (!id) {
                this.toast('warn', '请先保存供应商再探测模型');
                return;
            }
            const r = await this._api('POST', `/api/providers/${id}/discover`);
            if (r.ok && r.data?.ok) {
                this.providerModal.form.discoveredModels = r.data.models || [];
                this.toast('success', this.tt('discoverSuccess').replace('{n}', r.data.models?.length || 0));
                // refresh main list as well
                await this.loadProviders();
            } else {
                this.toast('error', this.tt('discoverFailed'), r.data?.error || '');
            }
        },

        async submitProviderModal() {
            const f = this.providerModal.form;
            if (!f.name) { this.toast('warn', '请输入别名'); return; }
            if (!this.providerModal.editing && !f.apiKey) {
                this.toast('warn', '请输入秘钥');
                return;
            }
            const payload = {
                type: f.type, name: f.name, baseUrl: f.baseUrl,
                selectedModels: f.selectedModels,
                supportsNativeResponses: !!f.supportsNativeResponses
            };
            if (f.apiKey) payload.apiKey = f.apiKey;

            let r;
            if (this.providerModal.editing) {
                r = await this._api('PUT', `/api/providers/${f.id}`, payload);
            } else {
                r = await this._api('POST', '/api/providers', payload);
            }
            if (r.ok) {
                this.toast('success', this.tt('saved'));
                this.closeProviderModal();
                await this.loadProviders();
            } else {
                this.toast('error', this.tt('error'), r.data?.error || '保存失败');
            }
        },

        async toggleProviderEnabled(p, enabled) {
            const r = await this._api('PUT', `/api/providers/${p.id}`, { enabled });
            if (r.ok) {
                p.enabled = enabled;
            } else {
                this.toast('error', this.tt('error'), r.data?.error || '');
            }
        },

        async discoverProviderModels(p) {
            this.toast('info', this.tt('discoverModels') + '…');
            const r = await this._api('POST', `/api/providers/${p.id}/discover`);
            if (r.ok && r.data?.ok) {
                this.toast('success', this.tt('discoverSuccess').replace('{n}', r.data.models?.length || 0));
                await this.loadProviders();
            } else {
                this.toast('error', this.tt('discoverFailed'), r.data?.error || '');
            }
        },

        async validateProvider(p) {
            this.toast('info', this.tt('validate') + '…');
            const r = await this._api('POST', `/api/providers/${p.id}/validate`);
            if (r.ok && r.data?.ok) {
                if (r.data.valid) this.toast('success', this.tt('validateSuccess'));
                else this.toast('error', this.tt('validateFailed'));
            } else {
                this.toast('error', this.tt('validateFailed'), r.data?.error || '');
            }
        },

        async checkModelHealth(p, model) {
            this.toast('info', `检查模型 ${model} 健康状态…`);
            const r = await this._api('POST', `/api/providers/${p.id}/health/${encodeURIComponent(model)}`);
            if (r.ok && r.data?.ok) {
                this.providerModal.modelHealthStatus[model] = {
                    ok: true,
                    status: r.data.status,
                    responseTime: r.data.responseTime,
                    checkedAt: Date.now()
                };
                const msg = `✓ ${model}\n响应时间: ${r.data.responseTime}ms\n状态: ${r.data.status}`;
                this.toast('success', msg);
            } else {
                this.providerModal.modelHealthStatus[model] = {
                    ok: false,
                    status: 'unhealthy',
                    error: r.data?.error || '未知错误',
                    checkedAt: Date.now()
                };
                const err = r.data?.error || '未知错误';
                this.toast('error', `✗ ${model}\n${err.slice(0, 100)}`);
            }
        },

        async confirmDeleteProvider(p) {
            const ok = await this.confirmAsk(this.tt('confirmDeleteProvider'));
            if (!ok) return;
            const r = await this._api('DELETE', `/api/providers/${p.id}`);
            if (r.ok) {
                this.toast('success', this.tt('deleted'));
                await this.loadProviders();
            } else {
                this.toast('error', this.tt('error'), r.data?.error || '');
            }
        },

        // ─── Mapping Modal ─────────────────────────────────────────────────
        mappingModal: {
            open: false,
            editing: null,
            form: {
                id: '', name: '', type: 'openai', localSk: '', strategy: 'fixed',
                contextLimit: 1000000, compressThreshold: 500000, timeWindowMinutes: 60,
                allowedEndpoints: ['chat', 'responses', 'messages']
            }
        },

        openMappingModal(editing = null) {
            this.mappingModal = {
                open: true,
                editing,
                form: editing
                    ? {
                        id: editing.id,
                        name: editing.name || '',
                        type: editing.type || 'openai',
                        localSk: editing.localSk || '',
                        strategy: editing.strategy || 'fixed',
                        contextLimit: editing.contextLimit || 1000000,
                        compressThreshold: editing.compressThreshold || 500000,
                        timeWindowMinutes: editing.timeWindowMinutes || 60,
                        allowedEndpoints: editing.allowedEndpoints || ['chat', 'responses', 'messages']
                    }
                    : {
                        id: '', name: '新映射', type: 'openai',
                        localSk: this._genSkStr(),
                        strategy: 'fixed',
                        contextLimit: 1000000, compressThreshold: 500000,
                        timeWindowMinutes: 60,
                        allowedEndpoints: ['chat', 'responses', 'messages']
                    }
            };
        },

        closeMappingModal() { this.mappingModal.open = false; },

        _genSkStr() {
            // sk- + 32 hex chars
            const arr = new Uint8Array(16);
            (window.crypto || window.msCrypto).getRandomValues(arr);
            return 'sk-' + [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
        },

        genSk() {
            this.mappingModal.form.localSk = this._genSkStr();
        },

        async submitMappingModal() {
            const f = this.mappingModal.form;
            if (!f.name) { this.toast('warn', '请输入名称'); return; }
            if (!f.localSk) { this.toast('warn', '请输入或生成本地秘钥'); return; }

            const payload = {
                name: f.name,
                type: f.type,
                localSk: f.localSk,
                strategy: f.strategy,
                contextLimit: f.contextLimit,
                compressThreshold: f.compressThreshold,
                timeWindowMinutes: f.timeWindowMinutes,
                allowedEndpoints: f.allowedEndpoints
            };

            let r;
            if (this.mappingModal.editing) {
                r = await this._api('PUT', `/api/mappings/${f.id}`, payload);
            } else {
                r = await this._api('POST', '/api/mappings', payload);
            }
            if (r.ok) {
                this.toast('success', this.tt('saved'));
                this.closeMappingModal();
                await this.loadMappings();
            } else {
                this.toast('error', this.tt('error'), r.data?.error || '保存失败');
            }
        },

        async toggleMappingEnabled(m, enabled) {
            const r = await this._api('PUT', `/api/mappings/${m.id}`, { enabled });
            if (r.ok) m.enabled = enabled;
            else this.toast('error', this.tt('error'), r.data?.error || '');
        },

        async confirmDeleteMapping(m) {
            const ok = await this.confirmAsk(this.tt('confirmDeleteMapping'));
            if (!ok) return;
            const r = await this._api('DELETE', `/api/mappings/${m.id}`);
            if (r.ok) {
                this.toast('success', this.tt('deleted'));
                await this.loadMappings();
            } else {
                this.toast('error', this.tt('error'), r.data?.error || '');
            }
        },

        addRule(m) {
            if (!Array.isArray(m.rules)) m.rules = [];
            m.rules.push({ enabled: true, providerId: '', inputModel: '', mappedModel: '', note: '' });
            this.persistMapping(m);
        },

        isRulePinned(m, ruleIndex) {
            if (m.pinnedRuleIndex == null) return false;
            if (m.pinnedUntil && this._now >= m.pinnedUntil) return false;
            return m.pinnedRuleIndex === ruleIndex;
        },

        isRuleActive(m, ruleIndex) {
            const rule = (m.rules || [])[ruleIndex];
            if (!rule || rule.enabled === false || !rule.inputModel) return false;
            if (this.isRulePinned(m, ruleIndex)) return true;
            const hasActivePin = m.pinnedRuleIndex != null && this.twIsPinActive(m);
            const hasExpiredPin = m.pinnedRuleIndex != null && !hasActivePin;
            if (hasActivePin) return false;
            if (!hasExpiredPin && m.activeRuleIndexes && m.activeRuleIndexes[rule.inputModel] === ruleIndex) return true;
            const candidates = (m.rules || [])
                .map((r, i) => ({ r, i }))
                .filter(x => x.r.enabled !== false && x.r.inputModel === rule.inputModel);
            if (candidates.length <= 1) return true;
            if (m.strategy === 'fixed') return candidates[0].i === ruleIndex;
            const windowMs = (m.timeWindowMinutes || 60) * 60 * 1000;
            if (m.strategy === 'time-window') {
                const idx = Math.floor(Date.now() / windowMs) % candidates.length;
                return candidates[idx].i === ruleIndex;
            }
            return false;
        },

        ruleHasPeers(m, ruleIndex) {
            const rule = (m.rules || [])[ruleIndex];
            if (!rule || rule.enabled === false || !rule.inputModel) return false;
            return (m.rules || []).filter(r =>
                r.enabled !== false && r.inputModel === rule.inputModel
            ).length >= 2;
        },

        async pinRule(m, ruleIndex) {
            const r = await this._api('PUT', `/api/mappings/${m.id}`, { pinnedRuleIndex: ruleIndex, pinnedUntil: null });
            if (r.ok) {
                m.pinnedRuleIndex = ruleIndex;
                m.pinnedUntil = null;
            }
        },

        async unpinRule(m) {
            const r = await this._api('PUT', `/api/mappings/${m.id}`, { pinnedRuleIndex: null, pinnedUntil: null });
            if (r.ok) {
                m.pinnedRuleIndex = null;
                m.pinnedUntil = null;
            }
        },

        twIsPinActive(m) {
            if (m.pinnedRuleIndex == null) return false;
            if (m.pinnedUntil && this._now >= m.pinnedUntil) return false;
            return true;
        },

        twNextSwitchMs(m) {
            if (this.twIsPinActive(m) && m.pinnedUntil) {
                return Math.max(0, m.pinnedUntil - this._now);
            }
            const windowMs = (m.timeWindowMinutes || 60) * 60 * 1000;
            const nextBoundary = (Math.floor(this._now / windowMs) + 1) * windowMs;
            return Math.max(0, nextBoundary - this._now);
        },

        twCountdownText(m) {
            const ms = this.twNextSwitchMs(m);
            const totalSec = Math.floor(ms / 1000);
            const h = Math.floor(totalSec / 3600);
            const min = Math.floor((totalSec % 3600) / 60);
            const sec = totalSec % 60;
            if (h > 0) return `${h}:${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
            return `${min}:${String(sec).padStart(2,'0')}`;
        },

        async extendTimeWindow(m) {
            const windowMs = (m.timeWindowMinutes || 60) * 60 * 1000;
            let newUntil;
            if (this.twIsPinActive(m) && m.pinnedUntil) {
                newUntil = m.pinnedUntil + windowMs;
            } else {
                const nextBoundary = (Math.floor(Date.now() / windowMs) + 1) * windowMs;
                newUntil = nextBoundary + windowMs;
            }
            const activeIdx = this._twCurrentActiveIndex(m);
            const r = await this._api('PUT', `/api/mappings/${m.id}`, {
                pinnedRuleIndex: activeIdx,
                pinnedUntil: newUntil
            });
            if (r.ok) {
                m.pinnedRuleIndex = activeIdx;
                m.pinnedUntil = newUntil;
            }
        },

        _twCurrentActiveIndex(m) {
            const rules = m.rules || [];
            const candidates = rules
                .map((r, i) => ({ r, i }))
                .filter(x => x.r.enabled !== false && x.r.inputModel);
            if (candidates.length === 0) return null;
            if (m.pinnedRuleIndex != null) {
                const pinned = candidates.find(c => c.i === m.pinnedRuleIndex);
                if (pinned) return pinned.i;
            }
            const windowMs = (m.timeWindowMinutes || 60) * 60 * 1000;
            const idx = Math.floor(Date.now() / windowMs) % candidates.length;
            return candidates[idx].i;
        },

        async removeRule(m, ri) {
            const ok = await this.confirmAsk(this.tt('confirmDeleteRule'));
            if (!ok) return;
            m.rules.splice(ri, 1);
            this.persistMapping(m);
        },

        // Debounced save (called on every cell blur / change)
        persistMapping(m) {
            clearTimeout(this._persistTimer);
            this._persistTimer = setTimeout(async () => {
                // Only patch rule-level fields. localSk / name / type / strategy are
                // changed via the mapping modal, never by rule autosave — sending
                // them here can resurrect stale form state and re-trigger the
                // backend's "localSk already used" check.
                const payload = {
                    enabled: m.enabled,
                    rules: (m.rules || []).map(r => ({
                        enabled: r.enabled !== false,
                        providerId: r.providerId || '',
                        inputModel: r.inputModel || '',
                        mappedModel: r.mappedModel || '',
                        note: r.note || ''
                    }))
                };
                const r = await this._api('PUT', `/api/mappings/${m.id}`, payload);
                if (!r.ok) {
                    this.toast('error', this.tt('error'), r.data?.error || '保存失败');
                }
            }, 400);
        }
    };
}

window.app = app;

// Register with Alpine using its official `alpine:init` event so
// `x-data="app()"` resolves correctly in Alpine 3's expression scope.
document.addEventListener('alpine:init', () => {
    if (window.Alpine && Alpine.data) {
        Alpine.data('app', app);
    }
});
