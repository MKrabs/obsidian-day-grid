const { Plugin, PluginSettingTab, Setting, MarkdownRenderChild, MarkdownView, Notice, parseYaml, setIcon, debounce, moment } = require('obsidian');

// ponytail: hardcoded to the Jira plugin's current inlineIssuePrefix, read its setting if that ever changes.
const PREFIX = 'JIRA:';
const TITLE_MAX = 40; // Longest ticket title in a copied day, in characters.
const KEY_AT_START = /^JIRA:([A-Z][A-Z0-9]+-\d+)\s*(.*)$/;
const VALID_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const SECTION_END = /^(#{1,6}\s|-{3,}\s*$|```)/;
const GRID_BLOCK = /^```day-grid\s*$/;
const BULLET = /^(\s*)(?:[-*+]|\d+\.)\s*(?:\[.\]\s*)?(.*)$/;
const EMPTY_BULLET = /^\s*[-*+]\s*$/;
// Index 0 is Monday throughout: the order of the day settings, the mark classes and ISO weeks.
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MARK_CLASSES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
// days: the heading name for each weekday, Monday first; an empty name skips that day.
const DEFAULTS = { query: '', limit: 40, account: '', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', '', ''], dateFormat: '' };
const DAY_MS = 864e5;

/** Which weekday a line is a heading for (0 = Monday), or -1. "# Thu", "# <mark>Thu</mark> 05.11" and "# thu" all match "Thu". */
function dayOf(line, names) {
    const m = line.match(/^#\s+(.*)$/);
    if (!m) return -1;
    const text = m[1].replace(/<\/?mark[^>]*>/g, '').trim().toLowerCase();
    return names.findIndex((n) => n && (text === n.toLowerCase() || text.startsWith(`${n.toLowerCase()} `)));
}

/**
 * Day sections between lines from and to: [{ day, name, start, end }], where day is the weekday (0 = Monday),
 * start is the heading line and end is exclusive.
 */
function parseDays(lines, names = DEFAULTS.days, from = 0, to = lines.length) {
    const days = [];
    for (let i = from; i < to; i++) {
        const day = dayOf(lines[i], names);
        if (day < 0) continue;
        let end = i + 1;
        while (end < to && !SECTION_END.test(lines[end])) end++;
        days.push({ day, name: names[day], start: i, end });
        i = end - 1;
    }
    return days;
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

/** The ISO week of a Monday timestamp, written like "2026-W45". */
function isoWeek(monday) {
    const thursday = new Date(monday + 3 * DAY_MS);
    const year = thursday.getUTCFullYear();
    const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
    return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Headings for a new week: each named day, optionally followed by its date via formatDate(utcTimestamp). */
function dayHeadings(names, monday, formatDate) {
    return names
        .map((name, i) => name && `# <mark class="${MARK_CLASSES[i]}">${name}</mark>${formatDate ? ` ${formatDate(monday + i * DAY_MS)}` : ''}\n\n- \n`)
        .filter(Boolean)
        .join('\n---\n');
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
            const result = await window.$ji.defaulted.getSearchResults(weekQuery(this.options.query, this.options.week), { limit: this.options.limit || 40, account });
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

    /** Writes the configured day headings below the block, and this week's number when the block has none. */
    async addDays() {
        const end = this.blockEnd();
        const editor = await this.editor();
        if (!editor) return;
        if (end === null) { new Notice('Could not find this grid in the note.'); return; }
        const { days, dateFormat } = this.plugin.settings;
        const monday = weekMonday(this.options.week || '') ?? mondayOf(new Date());
        const headings = dayHeadings(days, monday, dateFormat ? (t) => moment.utc(t).format(dateFormat) : null);
        if (!headings) { new Notice('No days set: add some in Settings → Day Grid.'); return; }
        editor.replaceRange(`\n\n${headings}`, { line: end, ch: editor.getLine(end).length });
        // Below the insert above, so its position is still right.
        if (!this.options.week) editor.replaceRange(`week: ${isoWeek(monday)}\n`, { line: end, ch: 0 });
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
        const name = section ? section.name : 'that day';
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
            const empty = el.createDiv({ cls: 'day-grid-status', text: 'No days below this grid yet. ' });
            empty.createEl('button', { text: 'Add days below' }).addEventListener('click', () => this.addDays());
            return;
        }

        const logged = sections.map((s) => new Set(parseEntries(lines, s).map((e) => e.key).filter(Boolean)));
        const noteKeys = [...new Set(logged.flatMap((set) => [...set]))];
        const keys = [...new Set([...this.searchKeys, ...noteKeys])];
        // Only highlight today when this grid is for the current week.
        const weekStart = this.options.week ? weekMonday(this.options.week) : mondayOf(new Date());
        const today = weekStart === mondayOf(new Date()) ? (new Date().getDay() + 6) % 7 : -1;

        const table = el.createEl('table');
        const dayCell = (row, day) => {
            const cell = row.createEl('td', { cls: 'day-grid-cell' });
            if (day === today) cell.addClass('is-today');
            return cell;
        };

        const head = table.createEl('thead').createEl('tr');
        head.createEl('th', { text: 'Ticket' });
        head.createEl('th', { text: 'Summary' });
        head.createEl('th', { text: 'Status' });
        sections.forEach(({ day, name }) => {
            const th = head.createEl('th', { cls: 'day-grid-cell' });
            if (day === today) th.addClass('is-today');
            th.createEl('mark', { cls: MARK_CLASSES[day], text: name });
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
            sections.forEach(({ day, name }, i) => {
                const on = logged[i].has(key);
                const button = dayCell(row, day).createEl('button', {
                    cls: on ? 'day-grid-dot is-on' : 'day-grid-dot',
                    text: on ? '●' : '·',
                    attr: { 'aria-label': on ? `Go to ${key} on ${name}` : `Log ${key} on ${name}`, 'aria-pressed': String(on) },
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
        sections.forEach(({ day, name }, i) => {
            const button = dayCell(draft, day).createEl('button', {
                cls: 'day-grid-dot', text: '+', attr: { 'aria-label': `Log typed ticket on ${name}` },
            });
            button.addEventListener('click', () => this.logDraft(i));
        });

        const copy = table.createEl('tfoot').createEl('tr');
        copy.createEl('td', { text: 'Copy day', attr: { colspan: '3' } });
        sections.forEach(({ day, name }, i) => {
            const button = dayCell(copy, day).createEl('button', {
                cls: 'clickable-icon', attr: { 'aria-label': `Copy notes for ${name}` },
            });
            setIcon(button, 'copy');
            button.addEventListener('click', () => this.copyDay(i, button));
        });

        if (this.status) el.createDiv({ cls: 'day-grid-status', text: this.status });
        this.loadMissing(noteKeys);
    }
}

// ponytail: open grids keep the old settings until the note is reopened.
class DayGridSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        const settings = this.plugin.settings;
        const save = () => this.plugin.saveData(settings);
        containerEl.empty();
        new Setting(containerEl)
            .setName('Jira query')
            .setDesc('JQL for the grid rows. With week: 2026-W45 in a note\'s block, startOfWeek() and endOfWeek() mean that week.')
            .addTextArea((t) => t.setValue(settings.query).onChange((v) => { settings.query = v.trim(); save(); }));
        new Setting(containerEl)
            .setName('Limit')
            .setDesc('Most tickets to load.')
            .addText((t) => t.setValue(String(settings.limit)).onChange((v) => { settings.limit = Number(v) || DEFAULTS.limit; save(); }));
        new Setting(containerEl)
            .setName('Jira account')
            .setDesc('Account alias from the Jira plugin. Empty uses its default account.')
            .addText((t) => t.setValue(settings.account).onChange((v) => { settings.account = v.trim(); save(); }));

        new Setting(containerEl)
            .setName('Days')
            .setDesc('The day headings in your notes, in any language. Leave a day empty to skip it. '
                + 'A heading counts as that day when it starts with the name, so "# Thu 05.11" matches Thu.')
            .setHeading();
        WEEKDAY_NAMES.forEach((weekday, i) => new Setting(containerEl)
            .setName(weekday)
            .addText((t) => t.setPlaceholder('Skipped').setValue(settings.days[i]).onChange((v) => { settings.days[i] = v.trim(); save(); })));
        new Setting(containerEl)
            .setName('Date after the name')
            .setDesc('Used by "Add days below". A moment.js format such as DD.MM gives "Thu 05.11". Empty adds no date.')
            .addText((t) => t.setPlaceholder('DD.MM').setValue(settings.dateFormat).onChange((v) => { settings.dateFormat = v.trim(); save(); }));
    }
}

class DayGridPlugin extends Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULTS, await this.loadData());
        this.settings.days = [...this.settings.days]; // Own copy, so editing it never changes DEFAULTS.
        this.addSettingTab(new DayGridSettingTab(this.app, this));
        this.registerMarkdownCodeBlockProcessor('day-grid', (source, el, ctx) => {
            ctx.addChild(new GridView(el, this, source, ctx));
        });
    }
}

module.exports = DayGridPlugin;
Object.assign(module.exports, { parseDays, gridScope, parseEntries, daySummary, planInsert, shortenTitle, weekQuery, weekMonday, mondayOf, isoWeek, dayHeadings });
