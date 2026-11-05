const { Plugin, PluginSettingTab, Setting, MarkdownRenderChild, MarkdownView, Notice, parseYaml, setIcon, debounce } = require('obsidian');

// ponytail: hardcoded to the Jira plugin's current inlineIssuePrefix, read its setting if that ever changes.
const PREFIX = 'JIRA:';
const TITLE_MAX = 40; // Longest ticket title in a copied day, in characters.
const KEY_AT_START = /^JIRA:([A-Z][A-Z0-9]+-\d+)\s*(.*)$/;
const VALID_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const SECTION_END = /^(#{1,6}\s|-{3,}\s*$|```)/;
const GRID_BLOCK = /^```day-grid\s*$/;
const BULLET = /^(\s*)(?:[-*+]|\d+\.)\s*(?:\[.\]\s*)?(.*)$/;
const EMPTY_BULLET = /^\s*[-*+]\s*$/;
const MARK_CLASS = /<mark\s[^>]*class=["']([^"']*)["']/i;
const VALID_CLASS = /^[A-Za-z_-][\w-]*$/;
const VALID_COLOR = /^#[0-9a-f]{3,8}$/i;
const WEEKDAY_CLASSES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']; // In Date.getDay() order.
// A day is a heading with <mark class="cls">; title is its column name in the grid and the text of an empty mark;
// bg and fg color the mark.
const DEFAULT_DAYS = [
    { cls: 'monday', title: 'Mon', bg: '#ab5852', fg: '#ffddd5' },
    { cls: 'tuesday', title: 'Tue', bg: '#eadaa0', fg: '#706743' },
    { cls: 'wednesday', title: 'Wed', bg: '#d69e49', fg: '#6f4a03' },
    { cls: 'thursday', title: 'Thu', bg: '#838469', fg: '#ffffff' },
    { cls: 'friday', title: 'Fri', bg: '#476066', fg: '#bfc1c2' },
];

/** Whether a day class names this weekday, in full ("monday") or short ("mon"), any case. */
function isWeekday(cls, weekday) {
    const c = cls.toLowerCase();
    return c === weekday || c === weekday.slice(0, 3);
}

/** A Daily notes template with the grid block and an empty-marked heading for each day in the list. */
function templateText(days) {
    const headings = days
        .filter((d) => VALID_CLASS.test(d.cls || ''))
        .map((d) => `### <mark class="${d.cls}"></mark>\n\n- \n`)
        .join('\n---\n');
    return `\`\`\`day-grid\nweek: {{date:GGGG-[W]WW}}\n\`\`\`\n\n${headings}`;
}
const DAY_MS = 864e5;

/** Which entry of days a line is the heading for, or -1: a heading holding <mark class="…"> with that class, any case. */
function dayOf(line, days) {
    if (!/^#{1,6}\s/.test(line)) return -1;
    const m = line.match(MARK_CLASS);
    if (!m) return -1;
    const classes = m[1].toLowerCase().split(/\s+/);
    return days.findIndex((d) => d.cls && classes.includes(d.cls.toLowerCase()));
}

/**
 * Day sections between lines from and to: [{ day, cls, title, start, end }], where day is the index in days,
 * start is the heading line and end is exclusive.
 */
function parseDays(lines, days = DEFAULT_DAYS, from = 0, to = lines.length) {
    const sections = [];
    for (let i = from; i < to; i++) {
        const day = dayOf(lines[i], days);
        if (day < 0) continue;
        let end = i + 1;
        while (end < to && !SECTION_END.test(lines[end])) end++;
        sections.push({ day, cls: days[day].cls, title: days[day].title || days[day].cls, start: i, end });
        i = end - 1;
    }
    return sections;
}

/**
 * CSS giving each day's mark its colors and marker shape, and showing the day's title in an empty mark
 * (<mark class="mon"></mark>) without writing it into the note. Entries with an unusable class or color are left out.
 */
function dayCss(days) {
    const ok = days.filter((d) => VALID_CLASS.test(d.cls || '') && VALID_COLOR.test(d.bg || '') && VALID_COLOR.test(d.fg || ''));
    if (!ok.length) return '';
    const sel = (d) => `mark[class~="${d.cls}" i]`;
    const text = (d) => `"${(d.title || d.cls).replace(/[\\"]/g, '\\$&').replace(/\s+/g, ' ')}"`;
    return ok.map((d) => `${sel(d)} { background-color: ${d.bg}; color: ${d.fg}; }\n${sel(d)}:empty::before { content: ${text(d)}; }`).join('\n')
        + `\nmark:is(${ok.map(sel).join(', ')}) { padding: 0.1em 0.4em; border-radius: 0.3em; `
        + '-webkit-box-decoration-break: clone; box-decoration-break: clone; }';
}

/**
 * What's wrong with a Daily notes setup for Day Grid, judged from its date format and template text:
 * [{ level: 'error' | 'warning', text }]. Empty means fine.
 */
function templateProblems(format, template) {
    const problems = [];
    const block = template.match(/^```day-grid[ \t]*\n([\s\S]*?)^```/m);
    if (!block) problems.push({ level: 'error', text: 'The template has no ```day-grid block, so new notes get no grid.' });
    else if (!/^week:/m.test(block[1])) {
        problems.push({ level: 'warning', text: 'The day-grid block has no "week: {{date:GGGG-[W]WW}}" line, so old notes will show the current week.' });
    }
    // Moment week tokens are w and W; text in [brackets] is literal.
    if (!/[wW]/.test((format || 'YYYY-MM-DD').replace(/\[[^\]]*\]/g, ''))) {
        problems.push({ level: 'warning', text: `The date format "${format || 'YYYY-MM-DD'}" has no week (W or WW), so you get a new note every day.` });
    }
    return problems;
}

/** The lines a grid owns: from just below its block (which ends at blockEnd) to the next day-grid block or the end. */
function gridScope(lines, blockEnd) {
    let to = blockEnd + 1;
    while (to < lines.length && !GRID_BLOCK.test(lines[to])) to++;
    return { from: blockEnd + 1, to };
}

/** Top-level items of a section, each with its nested notes. Empty bullets are dropped. */
function parseEntries(lines, section) {
    const entries = [];
    for (let i = section.start + 1; i < section.end; i++) {
        const bullet = lines[i].match(BULLET);
        const text = (bullet ? bullet[2] : lines[i]).trim();
        if (!text) continue;
        const current = entries[entries.length - 1];
        if (bullet && bullet[1].length > 0 && current) {
            current.notes.push(text);
            current.lastLine = i;
            continue;
        }
        const key = text.match(KEY_AT_START);
        entries.push({
            key: key ? key[1] : null,
            text: key ? key[1] : text.split(PREFIX).join(''),
            notes: key && key[2] ? [key[2]] : [],
            line: i,
            lastLine: i,
        });
    }
    return entries;
}

/** Cuts a title to at most max characters plus "…", ending on a whole word when there is one. */
function shortenTitle(title, max = TITLE_MAX) {
    if (title.length <= max) return title;
    const cut = title.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s.,;:-]+$/, '') + '…';
}

/** A day's text as written, minus empty bullets, with each ticket line as "- ABC-1: Its summary". */
function daySummary(lines, section, summaryOf = () => '') {
    const out = [];
    for (let i = section.start + 1; i < section.end; i++) {
        const line = lines[i].replace(/\s+$/, '').replace(/^\s+/, (s) => s.replace(/\t/g, '    '));
        if (EMPTY_BULLET.test(line)) continue;
        if (!line) {
            if (out.length && out[out.length - 1]) out.push('');
            continue;
        }
        const ticket = line.match(/^(\s*[-*+]\s+)JIRA:([A-Z][A-Z0-9]+-\d+)\s*(.*)$/);
        if (ticket) {
            const detail = [summaryOf(ticket[2]), ticket[3]].filter(Boolean).join(' - ');
            out.push(`${ticket[1]}${ticket[2]}${detail ? `: ${detail}` : ''}`);
        } else {
            out.push(line.split(PREFIX).join(''));
        }
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
}

/**
 * Pins startOfWeek()/endOfWeek() in a query to an ISO week like "2026-W45" (Monday 00:00 to Sunday 23:59).
 * Without a week the query is left as is, so Jira resolves it relative to today.
 */
function weekQuery(query, week) {
    if (!week) return query;
    const monday = weekMonday(week);
    if (monday === null) throw new Error(`week "${week}" should look like 2026-W45`);
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    return query
        .replace(/startOfWeek\(\)/g, `"${day(monday)}"`)
        .replace(/endOfWeek\(\)/g, `"${day(monday + 6 * DAY_MS)} 23:59"`);
}

/** Monday of an ISO week like "2026-W45", as a UTC timestamp, or null when the week isn't written like that. */
function weekMonday(week) {
    const m = String(week).trim().match(/^(\d{4})-W(\d{1,2})$/);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 53) return null;
    const jan4 = Date.UTC(Number(m[1]), 0, 4);
    return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS + (Number(m[2]) - 1) * 7 * DAY_MS;
}

/** Monday of the week a local date falls in, as a UTC timestamp. */
function mondayOf(date) {
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - ((date.getDay() + 6) % 7) * DAY_MS;
}

/** Where a new ticket goes: reuse a trailing empty bullet, otherwise add after the last line with content. */
function planInsert(lines, section) {
    let last = section.end - 1;
    while (last > section.start && !lines[last].trim()) last--;
    return { line: last, replace: last > section.start && EMPTY_BULLET.test(lines[last]) };
}

class GridView extends MarkdownRenderChild {
    constructor(el, plugin, source, ctx) {
        super(el);
        this.plugin = plugin;
        this.ctx = ctx;
        this.sourcePath = ctx.sourcePath;
        // Plugin settings are the shared defaults; anything written in the block overrides them for this note.
        this.options = Object.assign({}, plugin.settings);
        try { Object.assign(this.options, parseYaml(source) || {}); } catch (e) { /* bad YAML: fall back to the settings */ }
        this.issues = new Map();
        this.searchKeys = []; // Row order: Jira's result order. The map's insertion order depends on which request lands first.
        this.status = 'Loading tickets…';
        this.draftKey = '';
    }

    onload() {
        const refresh = debounce(() => this.render(), 150, true);
        this.registerEvent(this.plugin.app.workspace.on('editor-change', (editor, info) => {
            if (info && info.file && info.file.path === this.sourcePath) refresh();
        }));
        this.registerEvent(this.plugin.app.vault.on('modify', (file) => {
            if (file.path === this.sourcePath) refresh();
        }));
        this.render().then(() => this.loadIssues());
    }

    view() {
        return this.plugin.app.workspace.getLeavesOfType('markdown')
            .map((leaf) => leaf.view)
            .find((v) => v instanceof MarkdownView && v.file && v.file.path === this.sourcePath);
    }

    async text() {
        const view = this.view();
        if (view && view.editor) return view.editor.getValue();
        const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
        return file ? this.plugin.app.vault.cachedRead(file) : '';
    }

    async loadIssues() {
        // The Jira plugin may still be starting up when the note first renders.
        for (let i = 0; i < 20 && !window.$ji; i++) await new Promise((r) => setTimeout(r, 300));
        if (!window.$ji) {
            this.status = 'Jira plugin unavailable: showing only tickets already in this note.';
            return this.render();
        }
        const account = this.options.account ? window.$ji.account.getAccountByAlias(this.options.account) : undefined;
        this.account = account;
        try {
            if (!this.options.query) throw new Error('no query: set one in Settings → Day Grid');
            // The Jira plugin's own search falls back to 50, not to its "Default search results limit", so read that here.
            const limit = Number(this.options.limit) || (await this.plugin.jiraSettings()).searchResultsLimit;
            const result = await window.$ji.defaulted.getSearchResults(weekQuery(this.options.query, this.options.week), { limit, account });
            result.issues.forEach((issue) => this.issues.set(issue.key, issue));
            this.searchKeys = result.issues.map((issue) => issue.key);
            this.account = account || result.account;
            this.status = '';
        } catch (e) {
            this.status = `Could not load tickets from Jira (${e && e.message ? e.message : e}). Logging and copying still work.`;
        }
        await this.render();
    }

    /** Names tickets that were logged by hand and aren't in the search results. Failures just leave the key alone. */
    async loadMissing(keys) {
        this.requested = this.requested || new Set();
        const missing = keys.filter((k) => !this.issues.has(k) && !this.requested.has(k));
        if (!missing.length || !window.$ji) return;
        missing.forEach((k) => this.requested.add(k));
        const results = await Promise.allSettled(missing.map((k) =>
            window.$ji.defaulted.getIssue(k, { account: this.account })));
        results.forEach((r, i) => { if (r.status === 'fulfilled' && r.value) this.issues.set(missing[i], r.value); });
        if (results.some((r) => r.status === 'fulfilled')) await this.render();
    }

    /** The editor for this note, switching out of reading view when needed. */
    async editor() {
        const view = this.view();
        if (!view) { new Notice('Open this note in a tab first.'); return null; }
        if (view.getMode() !== 'source') {
            const state = view.leaf.getViewState();
            state.state = Object.assign({}, state.state, { mode: 'source' });
            await view.leaf.setViewState(state);
        }
        this.plugin.app.workspace.setActiveLeaf(view.leaf, { focus: true });
        return view.editor;
    }

    /** Where this grid's block ends in the note, or null when Obsidian can't say (then the grid reads the whole note). */
    blockEnd() {
        const info = this.ctx.getSectionInfo(this.containerEl);
        return info ? info.lineEnd : null;
    }

    /**
     * The day sections this grid owns. Callers that switch to the editor first pass end in from before the switch:
     * switching re-renders the grid, and the old element no longer knows where it was.
     */
    sections(lines, end = this.blockEnd()) {
        const { from, to } = end === null ? { from: 0, to: lines.length } : gridScope(lines, end);
        return parseDays(lines, this.plugin.settings.days, from, to);
    }

    async logTicket(key, index) {
        const end = this.blockEnd();
        const editor = await this.editor();
        if (!editor) return;
        const lines = editor.getValue().split('\n');
        const section = this.sections(lines, end)[index];
        if (!section) { new Notice('That day is no longer in this note.'); return; }

        const existing = parseEntries(lines, section).find((e) => e.key === key);
        if (existing) {
            // Filled dot: jump to the ticket.
            const cursor = { line: existing.lastLine, ch: lines[existing.lastLine].length };
            editor.setCursor(cursor);
            editor.scrollIntoView({ from: cursor, to: cursor }, true);
            editor.focus();
        } else {
            // Empty dot: just write the ticket, leave the cursor where it is.
            const { line, replace } = planInsert(lines, section);
            const block = `- ${PREFIX}${key}\n\t- `;
            if (replace) editor.replaceRange(block, { line, ch: 0 }, { line, ch: lines[line].length });
            else editor.replaceRange(`\n${block}`, { line, ch: lines[line].length });
        }
        await this.render();
    }

    async copyDay(index, button) {
        const lines = (await this.text()).split('\n');
        const section = this.sections(lines)[index];
        const summaryOf = (key) => {
            const issue = this.issues.get(key);
            return issue && issue.fields.summary ? shortenTitle(issue.fields.summary) : '';
        };
        const summary = section ? daySummary(lines, section, summaryOf) : '';
        const name = section ? section.title : 'that day';
        if (!summary) { new Notice(`Nothing logged for ${name}.`); return; }
        try {
            await navigator.clipboard.writeText(summary);
            setIcon(button, 'check');
            window.setTimeout(() => setIcon(button, 'copy'), 1000);
            new Notice(`Copied ${name}.`);
        } catch (e) {
            new Notice('Failed to copy to clipboard.');
        }
    }

    logDraft(index) {
        const key = this.draftKey.trim().toUpperCase();
        if (!VALID_KEY.test(key)) { new Notice('Type a ticket key like ABC-1234 first.'); return; }
        this.draftKey = '';
        return this.logTicket(key, index);
    }

    async render() {
        const lines = (await this.text()).split('\n');
        const sections = this.sections(lines);
        const el = this.containerEl;
        el.empty();
        el.addClass('day-grid');
        if (!sections.length) {
            el.createDiv({
                cls: 'day-grid-status',
                text: 'No days below this grid. A day is a heading with a <mark class="…"> from Settings → Day Grid → Days, like # <mark class="mon">Mon</mark>.',
            });
            return;
        }

        const logged = sections.map((s) => new Set(parseEntries(lines, s).map((e) => e.key).filter(Boolean)));
        const noteKeys = [...new Set(logged.flatMap((set) => [...set]))];
        const keys = [...new Set([...this.searchKeys, ...noteKeys])];
        // Only highlight today when this grid is for the current week.
        const weekStart = this.options.week ? weekMonday(this.options.week) : mondayOf(new Date());
        const today = weekStart === mondayOf(new Date()) ? WEEKDAY_CLASSES[new Date().getDay()] : null;

        const table = el.createEl('table');
        const dayCell = (row, cls) => {
            const cell = row.createEl('td', { cls: 'day-grid-cell' });
            if (today && isWeekday(cls, today)) cell.addClass('is-today');
            return cell;
        };

        const head = table.createEl('thead').createEl('tr');
        head.createEl('th', { text: 'Ticket' });
        head.createEl('th', { text: 'Summary' });
        head.createEl('th', { text: 'Status' });
        sections.forEach(({ cls, title }) => {
            const th = head.createEl('th', { cls: 'day-grid-cell' });
            if (today && isWeekday(cls, today)) th.addClass('is-today');
            th.createEl('mark', { cls, text: title });
        });

        const body = table.createEl('tbody');
        keys.forEach((key) => {
            const issue = this.issues.get(key);
            const row = body.createEl('tr');
            const keyCell = row.createEl('td', { cls: 'day-grid-key' });
            const account = (issue && issue.account) || this.account;
            if (account) {
                keyCell.createEl('a', { text: key, cls: 'external-link', href: `${account.webBaseUrl || account.host}/browse/${key}` });
            } else {
                keyCell.setText(key);
            }
            row.createEl('td', { cls: 'day-grid-summary', text: issue ? issue.fields.summary : '' });
            row.createEl('td', { cls: 'day-grid-state', text: issue && issue.fields.status ? issue.fields.status.name : '' });
            sections.forEach(({ cls, title }, i) => {
                const on = logged[i].has(key);
                const button = dayCell(row, cls).createEl('button', {
                    cls: on ? 'day-grid-dot is-on' : 'day-grid-dot',
                    text: on ? '●' : '·',
                    attr: { 'aria-label': on ? `Go to ${key} on ${title}` : `Log ${key} on ${title}`, 'aria-pressed': String(on) },
                });
                button.addEventListener('click', () => this.logTicket(key, i));
            });
        });

        const draft = body.createEl('tr', { cls: 'day-grid-draft' });
        const input = draft.createEl('td', { attr: { colspan: '3' } }).createEl('input', {
            type: 'text',
            placeholder: 'Other ticket key, then pick a day',
            attr: { 'aria-label': 'Other ticket key' },
        });
        input.value = this.draftKey;
        input.addEventListener('input', () => { this.draftKey = input.value; });
        sections.forEach(({ cls, title }, i) => {
            const button = dayCell(draft, cls).createEl('button', {
                cls: 'day-grid-dot', text: '+', attr: { 'aria-label': `Log typed ticket on ${title}` },
            });
            button.addEventListener('click', () => this.logDraft(i));
        });

        const copy = table.createEl('tfoot').createEl('tr');
        copy.createEl('td', { text: 'Copy day', attr: { colspan: '3' } });
        sections.forEach(({ cls, title }, i) => {
            const button = dayCell(copy, cls).createEl('button', {
                cls: 'clickable-icon', attr: { 'aria-label': `Copy notes for ${title}` },
            });
            setIcon(button, 'copy');
            button.addEventListener('click', () => this.copyDay(i, button));
        });

        if (this.status) el.createDiv({ cls: 'day-grid-status', text: this.status });
        this.loadMissing(noteKeys);
    }
}

// ponytail: open grids keep the old query, account and day titles until the note is reopened; colors apply at once.
class DayGridSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl, plugin } = this;
        const settings = plugin.settings;
        const save = () => plugin.saveSettings();
        containerEl.empty();

        new Setting(containerEl).setName('Jira').setHeading();
        const queryDesc = 'JQL for the grid rows. With week: 2026-W45 in a note\'s block, startOfWeek() and endOfWeek() mean that week.';
        const query = new Setting(containerEl)
            .setName('Query')
            .setDesc(queryDesc)
            .addTextArea((t) => t.setValue(settings.query).onChange((v) => { settings.query = v.trim(); save(); }));
        let accountInput;
        new Setting(containerEl)
            .setName('Account')
            .setDesc('Account alias from the Jira Issue plugin. Leave empty to use its default account.')
            .addText((t) => { accountInput = t.inputEl; t.setValue(settings.account).onChange((v) => { settings.account = v.trim(); save(); }); });
        plugin.jiraSettings().then((jira) => {
            const accounts = (jira.accounts || []).slice().sort((a, b) => (a.priority || 0) - (b.priority || 0));
            if (!plugin.jiraPlugin()) accountInput.placeholder = 'Jira Issue plugin not found';
            else if (accounts[0]) accountInput.placeholder = `Default: ${accounts[0].alias}`;
            if (jira.searchResultsLimit) {
                query.setDesc(`${queryDesc} Loads up to ${jira.searchResultsLimit} tickets, the Jira Issue plugin's "Default search results limit".`);
            }
        });

        new Setting(containerEl)
            .setName('Days')
            .setDesc('A day in a note is a heading with a <mark> using one of these classes, like # <mark class="mon">Mon</mark>. '
                + 'Each row: class, title in the grid, background color, text color.')
            .setHeading();
        settings.days.forEach((day, i) => {
            const row = new Setting(containerEl);
            const sample = row.nameEl.createEl('mark');
            const paint = () => {
                sample.setText(day.title || day.cls || 'New day');
                Object.assign(sample.style, { backgroundColor: day.bg, color: day.fg, padding: '0.1em 0.4em', borderRadius: '0.3em' });
                row.setDesc(VALID_CLASS.test(day.cls || '') ? '' : 'Class needs letters, digits, - or _ only.');
            };
            const change = (key) => (v) => { day[key] = v.trim(); paint(); save(); };
            row.addText((t) => t.setPlaceholder('class').setValue(day.cls).onChange(change('cls')))
                .addText((t) => t.setPlaceholder('Title').setValue(day.title).onChange(change('title')))
                .addColorPicker((c) => c.setValue(day.bg).onChange(change('bg')))
                .addColorPicker((c) => c.setValue(day.fg).onChange(change('fg')))
                .addExtraButton((b) => b.setIcon('trash').setTooltip('Remove this day').onClick(() => {
                    settings.days.splice(i, 1);
                    save();
                    this.display();
                }));
            paint();
        });
        new Setting(containerEl)
            .setDesc('Copy template puts a Daily notes template with the grid and one empty-marked heading per day above on '
                + 'your clipboard. Paste it into your template file.')
            .addButton((b) => b.setButtonText('Add day').onClick(() => {
                settings.days.push({ cls: '', title: '', bg: '#888888', fg: '#ffffff' });
                save();
                this.display();
            }))
            .addButton((b) => b.setButtonText('Copy template').setCta().onClick(async () => {
                try {
                    await navigator.clipboard.writeText(templateText(settings.days));
                    new Notice('Day Grid template copied.');
                } catch (e) {
                    new Notice('Failed to copy to clipboard.');
                }
            }));

        new Setting(containerEl)
            .setName('Daily notes')
            .setDesc('Day Grid is made for weekly notes created by the Daily notes core plugin from a template that holds the grid.')
            .setHeading();
        const status = containerEl.createDiv({ cls: 'day-grid-setup', text: 'Checking…' });
        plugin.dailyNotesProblems().then((problems) => {
            status.empty();
            if (!problems.length) status.createDiv({ cls: 'is-ok', text: '✓ Daily notes is set up for Day Grid.' });
            problems.forEach((p) => status.createDiv({ cls: `is-${p.level}`, text: `${p.level === 'error' ? '✗' : '⚠'} ${p.text}` }));
        });
    }
}

class DayGridPlugin extends Plugin {
    async onload() {
        const data = (await this.loadData()) || {};
        const days = Array.isArray(data.days) && data.days.every((d) => d && typeof d === 'object') ? data.days : DEFAULT_DAYS;
        // Settings from older versions (limit, dateFormat, days as plain names) are dropped here.
        this.settings = { query: data.query || '', account: data.account || '', days: days.map((d) => Object.assign({}, d)) };
        this.styleEl = document.head.createEl('style');
        this.register(() => this.styleEl.remove());
        this.applyColors();
        this.addSettingTab(new DayGridSettingTab(this.app, this));
        this.registerMarkdownCodeBlockProcessor('day-grid', (source, el, ctx) => {
            ctx.addChild(new GridView(el, this, source, ctx));
        });
    }

    applyColors() {
        this.styleEl.textContent = dayCss(this.settings.days);
    }

    saveSettings() {
        this.applyColors();
        return this.saveData(this.settings);
    }

    // ponytail: app.plugins and app.internalPlugins aren't public API, but they're how plugins reach each other's settings.
    jiraPlugin() {
        return this.app.plugins && this.app.plugins.plugins['obsidian-jira-issue'];
    }

    /** The Jira Issue plugin's saved settings (accounts, searchResultsLimit…), or {} when it isn't there. */
    async jiraSettings() {
        try {
            const jira = this.jiraPlugin();
            return (jira && await jira.loadData()) || {};
        } catch (e) {
            return {};
        }
    }

    /** What keeps Daily notes from making weekly notes with a grid: [{ level, text }], empty when it's fine. */
    async dailyNotesProblems() {
        const daily = this.app.internalPlugins && this.app.internalPlugins.getPluginById('daily-notes');
        if (!daily) return [{ level: 'warning', text: 'Could not check Daily notes on this version of Obsidian.' }];
        if (!daily.enabled) return [{ level: 'error', text: 'Daily notes is off. Turn it on in Settings → Core plugins.' }];
        const { format, template } = (daily.instance && daily.instance.options) || {};
        if (!template) return [{ level: 'error', text: 'Daily notes has no template. Set one in Settings → Daily notes.' }];
        const file = this.app.metadataCache.getFirstLinkpathDest(template, '');
        if (!file) return [{ level: 'error', text: `The Daily notes template "${template}" doesn't exist.` }];
        return templateProblems(format, await this.app.vault.cachedRead(file));
    }
}

module.exports = DayGridPlugin;
Object.assign(module.exports, { parseDays, gridScope, parseEntries, daySummary, planInsert, shortenTitle, weekQuery, weekMonday, mondayOf, dayCss, templateProblems, templateText, isWeekday });
