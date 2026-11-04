// Run with: node test.js
const Module = require('module'); const assert = require('assert');
const load = Module._load;
Module._load = (id, ...r) => id === 'obsidian' ? { Plugin: class {}, PluginSettingTab: class {}, MarkdownRenderChild: class {}, MarkdownView: class {} } : load(id, ...r);
const { parseDays, parseEntries, daySummary, planInsert, shortenTitle, weekQuery } = require('./main.js');

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
assert.deepStrictEqual(days.map((d) => d.day), ['Mon', 'Tue', 'Wed']);
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
assert.strictEqual(weekQuery(q, 'daily/2026 - Week 45 - Nov.md'), 'updated >= "2026-11-02" AND updated <= "2026-11-08 23:59" ORDER BY key');
assert.strictEqual(weekQuery(q, 'daily/2025 - Week 01 - Dec.md'), 'updated >= "2025-12-29" AND updated <= "2026-01-04 23:59" ORDER BY key');
assert.strictEqual(weekQuery(q, 'daily/2027 - Week 53 - Jan.md'), 'updated >= "2026-12-28" AND updated <= "2027-01-03 23:59" ORDER BY key');
assert.strictEqual(weekQuery(q, 'daily/template.md'), q);
console.log('ok');
