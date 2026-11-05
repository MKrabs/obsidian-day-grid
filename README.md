# Day Grid

A table at the top of your weekly note that lists your Jira tickets with one dot per weekday. Click a dot to log the ticket under that day, then copy a whole day's notes for your stand-up or timesheet.

![Day Grid with five tickets logged across Mon–Wed](screenshot.png)

*The grid for [`example.md`](example.md), a sample weekly note with made-up tickets.*

> Draft README.

## Prerequisites

- **Obsidian** 1.5 or later.
- **[Jira Issue](https://github.com/marc0l92/obsidian-jira-issue)** community plugin, installed, enabled and connected to your Jira account. Day Grid uses it to search Jira and to show `JIRA:ABC-123` links. Its inline issue prefix must be `JIRA:` (the default).
- **Daily notes** core plugin, if you want new weekly notes created from the template. Use a weekly date format, for example `YYYY - [Week] WW - MMM`.
- *Optional:* a CSS snippet that styles `<mark class="mon">` … `<mark class="fri">` to color the day headings. Without it the headings just look highlighted.

## Install

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/day-grid/`, then turn on **Day Grid** under Settings → Community plugins.

## Setup

1. **Settings → Day Grid**: these are shared by every note.
   - **Jira query**: the JQL for the rows, for example:
     ```
     project = ABC AND assignee = currentUser() AND updated >= startOfWeek() AND updated <= endOfWeek() ORDER BY key
     ```
   - **Limit**: the most tickets to load (default 40).
   - **Jira account**: an account alias from the Jira Issue plugin. Leave it empty to use its default account.
2. **Template**: copy `template.md` into your vault and set it as the Daily notes template. It contains the grid block and the Mon–Fri sections.

## Usage

Each weekly note starts with:

````
```day-grid
week: 2026-W45
```
````

- `week` sets the ISO week the note covers. `startOfWeek()` and `endOfWeek()` in the query then mean that week's Monday 00:00 and Sunday 23:59, so old notes keep showing their own tickets. The template fills it in when it creates the note (`{{date:GGGG-[W]WW}}`). Without it, Jira uses the current week.
- `query`, `limit` and `account` can also go in the block. They override the shared settings for that note only.

In the grid:

- **Empty dot**: adds `- JIRA:KEY` under that day's heading.
- **Filled dot**: jumps to the ticket's entry for that day.
- **Bottom row**: type a ticket key that isn't in the list, then click `+` under a day.
- **Copy day**: copies that day's notes, with each ticket line written as `- KEY: Summary`.

Rows follow the order of the query's results. Tickets you logged by hand that the query didn't return come last.

Day headings must be level-1 headings named `Mon`, `Tue` and so on, either plain (`# Mon`) or wrapped in a `<mark>`. A section ends at the next heading, a `---` line or a code fence.

## Development

`node test.js` runs the self-checks for the note parsing and the week calculation.
