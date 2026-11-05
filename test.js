// Run with: node test.js
const Module = require('module'); const assert = require('assert');
const load = Module._load;
Module._load = (id, ...r) => id === 'obsidian' ? { Plugin: class {}, PluginSettingTab: class {}, MarkdownRenderChild: class {}, MarkdownView: class {} } : load(id, ...r);
const { parseDays, gridScope, parseEntries, daySummary, planInsert, shortenTitle, weekQuery, weekMonday, mondayOf, dayCss, templateProblems, templateText, isWeekday } = require('./main.js');

assert.strictEqual(shortenTitle('Short title'), 'Short title');
assert.strictEqual(shortenTitle('x'.repeat(40)), 'x'.repeat(40));
assert.strictEqual(shortenTitle('Expose widget settings to the public facing API'), 'Expose widget settings to the public…');
assert.strictEqual(shortenTitle('y'.repeat(50)), 'y'.repeat(40) + '…');

const note = `# <mark class="monday">Mon</mark>

- JIRA:ABC-101
	- fixed the search.
	- waiting on review
- Environment setup
- 

---
# <mark class="tuesday">Tue</mark>

- 

---
# <mark class="wednesday">Wed</mark>

- JIRA:ABC-1 inline note
- mentions JIRA:ABC-2 here
- Planning
    - nested with spaces
---


\`\`\`day-grid
query: x
\`\`\``.split('\n');

const days = parseDays(note);
assert.deepStrictEqual(days.map((d) => [d.day, d.cls, d.title]), [[0, 'monday', 'Mon'], [1, 'tuesday', 'Tue'], [2, 'wednesday', 'Wed']]);
const [mon, tue, wed] = days;

assert.strictEqual(daySummary(note, mon), '- ABC-101\n    - fixed the search.\n    - waiting on review\n- Environment setup');
assert.strictEqual(daySummary(note, tue), '');
assert.strictEqual(daySummary(note, wed), '- ABC-1: inline note\n- mentions ABC-2 here\n- Planning\n    - nested with spaces');

const titles = { 'ABC-101': 'Add export button', 'ABC-102': 'Integrate settings view' };
const sample = `# <mark class="monday">Mon</mark>

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
const bare = ['# <mark class="friday">Fri</mark>', '', '---'];
assert.deepStrictEqual(planInsert(bare, parseDays(bare)[0]), { line: 0, replace: false });
assert.strictEqual(parseDays(['# Monday', '## Mon', '# <mark class="other">Mon</mark>', 'x']).length, 0, 'days need a mark with a known class');
const q = 'updated >= startOfWeek() AND updated <= endOfWeek() ORDER BY key';
assert.strictEqual(weekQuery(q, '2026-W45'), 'updated >= "2026-11-02" AND updated <= "2026-11-08 23:59" ORDER BY key');
assert.strictEqual(weekQuery(q, '2026-W01'), 'updated >= "2025-12-29" AND updated <= "2026-01-04 23:59" ORDER BY key');
assert.strictEqual(weekQuery(q, '2026-W53'), 'updated >= "2026-12-28" AND updated <= "2027-01-03 23:59" ORDER BY key');
assert.strictEqual(weekQuery(q, undefined), q);
assert.throws(() => weekQuery(q, '2026-45'));

// Two grids in one note: each owns only the days between its block and the next one. Fri before Thu is fine.
const h = (d) => `# <mark class="${{ Mon: "monday", Tue: "tuesday", Wed: "wednesday", Thu: "thursday", Fri: "friday" }[d]}">${d}</mark>`;
const two = `\n\`\`\`day-grid\nweek: 2026-W46\n\`\`\`\n\n${h('Mon')}\n\n${h('Tue')}\n\n${h('Wed')}\n- JIRA:ABC-123\n    - \n\n${h('Fri')}\n\n${h('Thu')}\n\n\n\`\`\`day-grid\nweek: 2026-W47\n\`\`\`\n\n${h('Mon')}\n\n${h('Tue')}\n\n${h('Wed')}\n\n${h('Fri')}\n\n${h('Thu')}\n`.split('\n');
const first = gridScope(two, 3);
const second = gridScope(two, 20);
assert.deepStrictEqual(first, { from: 4, to: 18 });
assert.deepStrictEqual(second, { from: 21, to: two.length });
const w46 = parseDays(two, undefined, first.from, first.to);
assert.deepStrictEqual(w46.map((d) => d.title), ['Mon', 'Tue', 'Wed', 'Fri', 'Thu']);
assert.deepStrictEqual(parseEntries(two, w46[2]).map((e) => e.key), ['ABC-123']);
assert.strictEqual(w46[4].end, 18, 'Thu stops at the next grid block');
assert.deepStrictEqual(parseDays(two, undefined, second.from, second.to).map((d) => d.start), [22, 24, 26, 28, 30]);
assert.deepStrictEqual(gridScope(['```day-grid', '```'], 1), { from: 2, to: 2 }, 'a grid with nothing below owns no lines');

// Own day list: custom classes and titles, any case, extra classes on the mark, any heading level.
const custom = [{ cls: 'pon', title: 'Pon' }, { cls: 'standup', title: 'Standup' }];
const cu = ['# <mark class="PON">Ponedeljak 02.11</mark>', '- a', '## <mark class="big standup">S</mark>', '# <mark class="mon">Mon</mark>', '- <mark class="pon">x</mark>', '# Pon'];
assert.deepStrictEqual(parseDays(cu, custom).map((d) => [d.day, d.cls, d.title, d.start]), [[0, 'pon', 'Pon', 0], [1, 'standup', 'Standup', 2]]);
assert.deepStrictEqual(parseDays(['# <mark class="mon">Mon</mark>'], [{ cls: 'mon', title: '' }]).map((d) => d.title), ['mon'], 'no title falls back to the class');

// Day colors: one rule per usable day, case-insensitive class match; bad classes and colors never reach the CSS.
const css = dayCss([{ cls: 'mon', bg: '#ab5852', fg: '#fff' }, { cls: 'x"]{}*{', bg: '#000', fg: '#fff' }, { cls: 'tue', bg: 'red;}', fg: '#fff' }]);
assert.ok(css.startsWith('mark[class~="mon" i] { background-color: #ab5852; color: #fff; }'));
assert.ok(!css.includes('x"]') && !css.includes('tue'));
assert.ok(css.includes('mark:is(mark[class~="mon" i])'));
assert.strictEqual(dayCss([]), '');
// Empty marks show the title (or the class when there's none), escaped so it can't break out of the CSS string.
assert.ok(css.includes('mark[class~="mon" i]:empty::before { content: "mon"; }'));
assert.ok(dayCss([{ cls: 'mon', title: 'Montag', bg: '#000', fg: '#fff' }]).includes(':empty::before { content: "Montag"; }'));
assert.ok(dayCss([{ cls: 'mon', title: 'a"b\\c\n}', bg: '#000', fg: '#fff' }]).includes('content: "a\\"b\\\\c }"; }'));

// Daily notes check: an error for no grid block, warnings for no week line or a daily format.
const good = '```day-grid\nweek: {{date:GGGG-[W]WW}}\n```\n\n# <mark class="mon">Mon</mark>\n';
assert.deepStrictEqual(templateProblems('YYYY - [Week] WW - MMM', good), []);
assert.deepStrictEqual(templateProblems('YYYY-[W]ww', good), []);
assert.deepStrictEqual(templateProblems('YYYY - [Week] WW', '# Mon\n').map((p) => p.level), ['error']);
assert.deepStrictEqual(templateProblems('YYYY - [Week] WW', '```day-grid\n```\n').map((p) => p.level), ['warning']);
assert.deepStrictEqual(templateProblems('YYYY-MM-DD [Weekly]', good).map((p) => p.level), ['warning'], 'W inside [brackets] is literal text');
assert.deepStrictEqual(templateProblems('', good).map((p) => p.level), ['warning'], 'empty format means YYYY-MM-DD');

const monday = weekMonday('2026-W45');
assert.strictEqual(mondayOf(new Date(2026, 10, 5)), monday);
assert.strictEqual(mondayOf(new Date(2026, 10, 8)), monday, 'Sunday ends the ISO week that started on Monday');

// Today matches a day class written in full or short, any case.
assert.ok(isWeekday('monday', 'monday') && isWeekday('Mon', 'monday') && !isWeekday('montag', 'monday') && !isWeekday('tuesday', 'monday'));

// Copy template: grid block plus one empty-marked heading per usable day, and the grid finds those days again.
const days2 = [{ cls: 'monday', title: 'Mon' }, { cls: 'bad class', title: 'X' }, { cls: 'friday', title: 'Fri' }];
const tpl = templateText(days2);
assert.strictEqual(tpl, '```day-grid\nweek: {{date:GGGG-[W]WW}}\n```\n\n### <mark class="monday"></mark>\n\n- \n\n---\n### <mark class="friday"></mark>\n\n- \n');
assert.deepStrictEqual(templateProblems('YYYY - [Week] WW', tpl), []);
assert.deepStrictEqual(parseDays(tpl.split('\n'), days2).map((d) => d.title), ['Mon', 'Fri']);

// The defaults use full class names, so short "mon" marks only count once the list says so.
assert.strictEqual(parseDays(['# <mark class="mon">Mon</mark>']).length, 0);
console.log('ok');
