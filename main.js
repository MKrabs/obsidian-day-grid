const { Plugin, MarkdownRenderChild, MarkdownView, Notice, parseYaml, setIcon, debounce } = require('obsidian');

// ponytail: hardcoded to the Jira plugin's current inlineIssuePrefix, read its setting if that ever changes.
const PREFIX = 'JIRA:';
const TITLE_MAX = 40; // Longest ticket title in a copied day, in characters.
const KEY_AT_START = /^JIRA:([A-Z][A-Z0-9]+-\d+)\s*(.*)$/;
const VALID_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const DAY_HEADING = /^#\s+(?:<mark[^>]*>)?(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:<\/mark>)?\s*$/;
const SECTION_END = /^(#{1,6}\s|-{3,}\s*$|```)/;
const BULLET = /^(\s*)(?:[-*+]|\d+\.)\s*(?:\[.\]\s*)?(.*)$/;
const EMPTY_BULLET = /^\s*[-*+]\s*$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Day sections of a note: [{ day, start, end }], where start is the heading line and end is exclusive. */
function parseDays(lines) {
    const days = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(DAY_HEADING);
        if (!m) continue;
        let end = i + 1;
        while (end < lines.length && !SECTION_END.test(lines[end])) end++;
        days.push({ day: m[1], start: i, end });
        i = end - 1;
    }
    return days;
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

/** Where a new ticket goes: reuse a trailing empty bullet, otherwise add after the last line with content. */
function planInsert(lines, section) {
    let last = section.end - 1;
    while (last > section.start && !lines[last].trim()) last--;
    return { line: last, replace: last > section.start && EMPTY_BULLET.test(lines[last]) };
}

class GridView extends MarkdownRenderChild {
    constructor(el, plugin, source, sourcePath) {
        super(el);
        this.plugin = plugin;
        this.sourcePath = sourcePath;
        this.options = {};
        try { this.options = parseYaml(source) || {}; } catch (e) { /* shown as a Jira error below */ }
        this.issues = new Map();
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
            if (!this.options.query) throw new Error('no query in the day-grid block');
            const result = await window.$ji.defaulted.getSearchResults(this.options.query, { limit: this.options.limit || 40, account });
            result.issues.forEach((issue) => this.issues.set(issue.key, issue));
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

    async logTicket(key, day) {
        const editor = await this.editor();
        if (!editor) return;
        const lines = editor.getValue().split('\n');
        const section = parseDays(lines).find((s) => s.day === day);
        if (!section) { new Notice(`No ${day} section in this note.`); return; }

        const existing = parseEntries(lines, section).find((e) => e.key === key);
        let cursor;
        if (existing) {
            cursor = { line: existing.lastLine, ch: lines[existing.lastLine].length };
        } else {
            const { line, replace } = planInsert(lines, section);
            const block = `- ${PREFIX}${key}\n\t- `;
            if (replace) editor.replaceRange(block, { line, ch: 0 }, { line, ch: lines[line].length });
            else editor.replaceRange(`\n${block}`, { line, ch: lines[line].length });
            const noteLine = replace ? line + 1 : line + 2;
            cursor = { line: noteLine, ch: 3 };
        }
        editor.setCursor(cursor);
        editor.scrollIntoView({ from: cursor, to: cursor }, true);
        editor.focus();
        await this.render();
    }

    async copyDay(day, button) {
        const lines = (await this.text()).split('\n');
        const section = parseDays(lines).find((s) => s.day === day);
        const summaryOf = (key) => {
            const issue = this.issues.get(key);
            return issue && issue.fields.summary ? shortenTitle(issue.fields.summary) : '';
        };
        const summary = section ? daySummary(lines, section, summaryOf) : '';
        if (!summary) { new Notice(`Nothing logged for ${day}.`); return; }
        try {
            await navigator.clipboard.writeText(summary);
            setIcon(button, 'check');
            window.setTimeout(() => setIcon(button, 'copy'), 1000);
            new Notice(`Copied ${day}.`);
        } catch (e) {
            new Notice('Failed to copy to clipboard.');
        }
    }

    logDraft(day) {
        const key = this.draftKey.trim().toUpperCase();
        if (!VALID_KEY.test(key)) { new Notice('Type a ticket key like ABC-1234 first.'); return; }
        this.draftKey = '';
        return this.logTicket(key, day);
    }

    async render() {
        const lines = (await this.text()).split('\n');
        const sections = parseDays(lines);
        const el = this.containerEl;
        el.empty();
        el.addClass('day-grid');
        if (!sections.length) {
            el.createDiv({ cls: 'day-grid-status', text: 'No day headings (# Mon … # Fri) found in this note.' });
            return;
        }

        const logged = new Map(sections.map((s) => [s.day, new Set(parseEntries(lines, s).map((e) => e.key).filter(Boolean))]));
        const noteKeys = [...new Set([...logged.values()].flatMap((set) => [...set]))];
        const keys = [...new Set([...this.issues.keys(), ...noteKeys])];
        const today = WEEKDAYS[new Date().getDay()];

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
        sections.forEach(({ day }) => {
            const th = head.createEl('th', { cls: 'day-grid-cell' });
            if (day === today) th.addClass('is-today');
            th.createEl('mark', { cls: day.toLowerCase(), text: day });
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
            sections.forEach(({ day }) => {
                const on = logged.get(day).has(key);
                const button = dayCell(row, day).createEl('button', {
                    cls: on ? 'day-grid-dot is-on' : 'day-grid-dot',
                    text: on ? '●' : '·',
                    attr: { 'aria-label': on ? `Go to ${key} on ${day}` : `Log ${key} on ${day}`, 'aria-pressed': String(on) },
                });
                button.addEventListener('click', () => this.logTicket(key, day));
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
        sections.forEach(({ day }) => {
            const button = dayCell(draft, day).createEl('button', {
                cls: 'day-grid-dot', text: '+', attr: { 'aria-label': `Log typed ticket on ${day}` },
            });
            button.addEventListener('click', () => this.logDraft(day));
        });

        const copy = table.createEl('tfoot').createEl('tr');
        copy.createEl('td', { text: 'Copy day', attr: { colspan: '3' } });
        sections.forEach(({ day }) => {
            const button = dayCell(copy, day).createEl('button', {
                cls: 'clickable-icon', attr: { 'aria-label': `Copy notes for ${day}` },
            });
            setIcon(button, 'copy');
            button.addEventListener('click', () => this.copyDay(day, button));
        });

        if (this.status) el.createDiv({ cls: 'day-grid-status', text: this.status });
        this.loadMissing(noteKeys);
    }
}

class DayGridPlugin extends Plugin {
    onload() {
        this.registerMarkdownCodeBlockProcessor('day-grid', (source, el, ctx) => {
            ctx.addChild(new GridView(el, this, source, ctx.sourcePath));
        });
    }
}

module.exports = DayGridPlugin;
Object.assign(module.exports, { parseDays, parseEntries, daySummary, planInsert, shortenTitle });
