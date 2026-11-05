// Run with: node test.js
const Module = require('module'); const assert = require('assert');
const load = Module._load;
Module._load = (id, ...r) => id === 'obsidian' ? { Plugin: class {}, PluginSettingTab: class {}, MarkdownRenderChild: class {}, MarkdownView: class {} } : load(id, ...r);
const { parseDays, gridScope, parseEntries, daySummary, planInsert, shortenTitle, weekQuery, weekMonday, mondayOf, isoWeek, dayHeadings } = require('./main.js');

assert.strictEqual(shortenTitle('Short title'), 'Short title');
assert.strictEqual(shortenTitle('x'.repeat(40)), 'x'.repeat(40));
assert.strictEqual(shortenTitle('Expose widget settings to the public facing API'), 'Expose widget settings to the public…');
assert.strictEqual(shortenTitle('y'.repeat(50)), 'y'.repeat(40) + '…');

const note = `# <mark class="mon">Mon</mark>

- JIRA:ABC-101
	- fixed the search.
	- waiting on review
- Environment setup
- 

---
# <mark class="tue">Tue</mark>

- 

---
# <mark class="wed">Wed</mark>

- JIRA:ABC-1 inline note
- mentions JIRA:ABC-2 here
- Planning
    - nested with spaces
---


\`\`\`day-grid
query: x
\`\`\``.split('\n');

const days = parseDays(note);
assert.deepStrictEqual(days.map((d) => [d.day, d.name]), [[0, 'Mon'], [1, 'Tue'], [2, 'Wed']]);
const [mon, tue, wed] = days;

assert.strictEqual(daySummary(note, mon), '- ABC-101\n    - fixed the search.\n    - waiting on review\n- Environment setup');
assert.strictEqual(daySummary(note, tue), '');
assert.strictEqual(daySummary(note, wed), '- ABC-1: inline note\n- mentions ABC-2 here\n- Planning\n    - nested with spaces');

const titles = { 'ABC-101': 'Add export button', 'ABC-102': 'Integrate settings view' };
const sample = `# Mon

- JIRA:ABC-101
    -
- JIRA:ABC-102
    - some details for the ticket 102
- other things i did during the day
-




some other things i did no as a bullet point
---`.split('\n');
assert.strictEqual(daySummary(sample, parseDays(sample)[0], (k) => titles[k]), `- ABC-101: Add export button
- ABC-102: Integrate settings view
    - some details for the ticket 102
- other things i did during the day

some other things i did no as a bullet point`);
assert.strictEqual(daySummary(['# Mon', '- JIRA:ABC-1 note', '---'], { start: 0, end: 2 }, () => 'Title'), '- ABC-1: Title - note');
assert.deepStrictEqual(parseEntries(note, wed).map((e) => e.key), ['ABC-1', null, null]);

assert.deepStrictEqual(planInsert(note, mon), { line: mon.start + 6, replace: true });
assert.deepStrictEqual(planInsert(note, tue), { line: tue.start + 2, replace: true });
assert.deepStrictEqual(planInsert(note, wed), { line: wed.start + 5, replace: false });
const bare = ['# Fri', '', '---'];
assert.deepStrictEqual(planInsert(bare, parseDays(bare)[0]), { line: 0, replace: false });
assert.strictEqual(parseDays(['# Monday', '## Mon', 'x']).length, 0);
const q = 'updated >= startOfWeek() AND updated <= endOfWeek() ORDER BY key';
assert.strictEqual(weekQuery(q, '2026-W45'), 'updated >= "2026-11-02" AND updated <= "2026-11-08 23:59" ORDER BY key');
assert.strictEqual(weekQuery(q, '2026-W01'), 'updated >= "2025-12-29" AND updated <= "2026-01-04 23:59" ORDER BY key');
assert.strictEqual(weekQuery(q, '2026-W53'), 'updated >= "2026-12-28" AND updated <= "2027-01-03 23:59" ORDER BY key');
assert.strictEqual(weekQuery(q, undefined), q);
assert.throws(() => weekQuery(q, '2026-45'));

// Two grids in one note: each owns only the days between its block and the next one. Fri before Thu is fine.
const two = '\n```day-grid\nweek: 2026-W46\n```\n\n# Mon\n\n# Tue\n\n# Wed\n- JIRA:ABC-123\n    - \n\n# Fri\n\n# Thu\n\n\n```day-grid\nweek: 2026-W47\n```\n\n# Mon\n\n# Tue\n\n# Wed\n\n# Fri\n\n# Thu\n'.split('\n');
const first = gridScope(two, 3);
const second = gridScope(two, 20);
assert.deepStrictEqual(first, { from: 4, to: 18 });
assert.deepStrictEqual(second, { from: 21, to: two.length });
const w46 = parseDays(two, undefined, first.from, first.to);
assert.deepStrictEqual(w46.map((d) => d.name), ['Mon', 'Tue', 'Wed', 'Fri', 'Thu']);
assert.deepStrictEqual(parseEntries(two, w46[2]).map((e) => e.key), ['ABC-123']);
assert.strictEqual(w46[4].end, 18, 'Thu stops at the next grid block');
assert.deepStrictEqual(parseDays(two, undefined, second.from, second.to).map((d) => d.start), [22, 24, 26, 28, 30]);
assert.deepStrictEqual(gridScope(['```day-grid', '```'], 1), { from: 2, to: 2 }, 'a grid with nothing below owns no lines');

// Own day names: any language, skipped days, case and text after the name (a date) all work.
const serbian = ['Pon', 'Uto', '', 'Čet', 'Pet', '', ''];
const sr = ['# Pon 02.11', '- a', '# <mark class="wed">Sre</mark>', '# čet', '# Petak', '# Pet'];
assert.deepStrictEqual(parseDays(sr, serbian).map((d) => [d.day, d.start]), [[0, 0], [3, 3], [4, 5]]);

// New weeks: headings for the configured days with their dates, and the week number to write.
const monday = weekMonday('2026-W45');
const date = (t) => new Date(t).toISOString().slice(8, 10) + '.' + new Date(t).toISOString().slice(5, 7);
assert.strictEqual(dayHeadings(['Mon', '', 'Wed', '', '', '', ''], monday, date),
    '# <mark class="mon">Mon</mark> 02.11\n\n- \n\n---\n# <mark class="wed">Wed</mark> 04.11\n\n- \n');
assert.strictEqual(dayHeadings(['', '', '', '', '', '', ''], monday), '');
assert.strictEqual(isoWeek(monday), '2026-W45');
assert.strictEqual(isoWeek(weekMonday('2026-W01')), '2026-W01');
assert.strictEqual(isoWeek(weekMonday('2026-W53')), '2026-W53');
assert.strictEqual(mondayOf(new Date(2026, 10, 5)), monday);
assert.strictEqual(mondayOf(new Date(2026, 10, 8)), monday, 'Sunday ends the ISO week that started on Monday');
// What "Add days below" writes is found again by the grid.
assert.deepStrictEqual(parseDays(dayHeadings(['Mon', 'Tue', '', '', '', '', ''], monday, date).split('\n'), ['Mon', 'Tue', '', '', '', '', '']).map((d) => d.name), ['Mon', 'Tue']);
console.log('ok');
