# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Your Codex plan usage can be read without asking ChatGPT for it.** The app already knew how to fetch your usage from the account switcher, which needs a valid sign-in and a working connection. Codex also writes the same figures into every conversation it records, so the app now reads them from your own disk: the plan you are on, how much of the current window you have used, when it resets, and your credit balance. It works offline and it cannot break because a sign-in expired. The display that uses it is still to come.

## [1.3.0-alpha.24] - 2026-08-13

Scroll up in a terminal and you now reach the whole conversation, not just what the terminal happened to draw. Select across it, from an hour ago down into the line being written right now, and copy the lot.

### Added

- **Scrolling up in a terminal reaches the whole session.** Wheel up at the top of what a pane has drawn and it keeps going, into the conversation the assistant recorded. It is the same surface: the same background, the same typeface, the same line spacing, no panel, no banner and nothing to turn on. Hold Shift and the wheel always goes there, whatever is running, which is what every other terminal does too.
- **You can drag up and copy history.** One drag from the current screen up into last hour's output selects a single continuous stretch, and Ctrl+C copies it. There is no boundary in the middle to get stuck on, because what is on screen is part of the same document as what came before it.
- **Ctrl+Shift+A now selects everything, including the history.** It used to select what the terminal had in memory, which for a coding assistant is one screen.
- **Shift+PageUp and Shift+PageDown page through it**, Escape leaves, and typing anything at all leaves and types. That last one is the point: there is no mode to be in and nothing to remember.
- **A quiet scrollbar shows how much there is.** Six pixels on the right edge, only while you are moving, fading out after a moment. Its size is the only thing telling you there is history above, which is why nothing else has to.
- **Output keeps flowing while you read.** Selecting text used to pause the terminal, and it no longer does: what pauses is the copy of the screen you are selecting on, so your selection stays put while the session underneath carries on. Nothing is queued and nothing catches up in a rush afterwards.

### Changed

- **The Select mode hint stopped standing on the screen.** It appears once, the first time you drag on a session that has taken over the mouse, and then never again. Select mode itself is unchanged.
- **Shells and build logs remember much further back.** A pane running a shell reaches its own scrollback first, exactly as before, and then keeps going into a deeper log the server keeps for it. That deeper log needs the `CWM_VT_SIDECAR=1` setting, and without it nothing changes.

### Notes for the next release

History on a phone works, but the touch polish (momentum through the boundary, the selection handles, the toolbar) is the next piece.

## [1.3.0-alpha.23] - 2026-08-13

The phone stopped hiding things from you. The bottom bar has five tabs instead of four, one of which used to be a drawer called More, and the microphone that has been in the code for months is finally on screen.

### Added

- **A Home screen.** It opens on a banner telling you how many sessions want your input, then the sessions running right now as cards, then the ones you were in most recently, then a Workspace list with everything else: agent tasks, project notes, costs, system resources, paired devices and settings. Nothing on it is more than one tap from where you land.
- **Attention is a tab, with a count on it.** Sessions waiting for you, sessions that failed and sessions that finished, grouped, in one place. The count on the tab is the only thing in the app that will nag you.
- **Search is a tab.** One field, and chips for what you are looking for: everything, sessions, commands, past conversations, or help.
- **The microphone works on a phone.** It was written, it was tested for browser support, and it lived on a strip of the terminal panel that phones do not draw, so on a phone it did not exist. It is now in the message row next to the image button, where the design put it.
- **The terminal's message row is always there.** It used to be behind a Type button that also did something else, which is why typing sometimes fought the terminal for the keyboard. Now you tap the field.
- **Raw keys.** For the rare command that wants every keystroke as you type it, a password prompt or a single-key menu, there is a Raw keys switch in the terminal's options. It says on screen when it is on, because it turns autocorrect off.
- **A terminal options sheet.** Reader, select mode, copy view, paste, Ctrl+D, send without Enter, send a newline, scheduled messages, pinned notes, move to another tab, reset, restart. Four of those had no way in from a phone at all.

### Fixed

- **The keyboard no longer breaks menus and dialogs.** When the keyboard opened, the app shifted the whole screen up by a few pixels to compensate. That one line quietly changed where every pop-up, sheet and dialog thought the screen was. It is gone, and the layout now measures the space the keyboard actually leaves.
- **The keyboard is detected properly.** It used to be a guess based on the physical size of your screen, which is wrong in landscape and wrong in an installed app.
- **The page no longer loses your scroll position when the keyboard opens.**
- **Notifications stopped landing on the terminal keys.** A message would appear exactly where the key row is and swallow the tap. It now sits above whatever is actually on screen, measured rather than assumed.
- **The floating clock button over the terminal is gone on phones.** It sat on top of the key row, it was invisible until you hovered, and a phone has no hover. Scheduled messages moved into the terminal options sheet, count and all.
- **Everything you can tap is now big enough to tap.** Thirty-seven controls were smaller than the 44-pixel minimum, including the whole project drawer, both header buttons and the close button on every terminal tab.
- **Nothing in the app blinks.** The pulsing dots the mobile design called for are static shapes instead: a filled dot for running, a ring for needs-input.
- **Codex sessions show their token usage instead of a dash.** There is no published price for them, so there is no dollar figure to show, and inventing one would be worse than showing nothing. The real number the app does have is now the one you see.
- **"Summarize to Docs" writes to your docs.** It was calling a route that had been shadowed by another one with the same address, so it reported success and appended nothing.

### Changed

- **The More tab is gone.** It was a sheet of fourteen unrelated things. Every one of them now has its own row on Home or its own tab. The full command list is still one tap away at the bottom of Home if you want it.
- **The bottom bar is 64 pixels tall**, matching the design, and its labels are readable in dark mode.
- **The phone stylesheet stopped using the old colour names**, so the phone follows the app's theme exactly like every other screen.

## [1.3.0-alpha.22] - 2026-08-13

Pasting into a terminal now does what you meant. The terminal itself got the design treatment the rest of the app has had.

### Fixed

- **Pasting two lines used to run two commands and print two blank lines.** Windows copies text with a carriage return AND a line feed on the end of every line, and both were being sent, so the shell saw each line submitted twice. Now one line break means one Enter, whatever you copied it from.
- **Pasting into a plain shell used to print `[200~` around whatever you pasted.** There is a terminal mode an application can turn on to say "hand me a paste in one piece", and the app was wrapping every paste in that marker whether the application had asked for it or not. Coding assistants do ask for it, which is why this looked fine most of the time; `cmd`, PowerShell and anything else did not, and got the marker as literal text. The app now checks.
- **A pasted file can no longer break out of a paste.** If the text you paste happens to contain the marker that ends a paste, everything after it would have been treated as though you had typed it. That marker is now stripped out of the pasted text.

### Added

- **Pasting several lines into a plain shell asks first.** It tells you how many lines and shows you the first one, with Paste and Cancel. It does not ask when you are pasting into a coding assistant, because those handle a multi-line paste properly; that is the whole point of the mode above. You can force it always on or always off in settings under `terminalConfirmMultilinePaste`.
- **Ctrl+Shift+C copies, always.** Plain Ctrl+C is ambiguous in a terminal: it copies when you have something selected and interrupts what is running when you do not, which means you have to know the state of something you cannot see. Ctrl+Shift+C only ever copies. Ctrl+C is unchanged.
- **Ctrl+Shift+A selects everything in the terminal.** Ctrl+A is deliberately left alone, because in a shell it means "jump to the start of the line" and taking that away would be a bad trade.
- **Terminals remember twice as much.** Scroll-back went from 5000 lines to 10000.

### Changed

- **The terminal pane is a card.** A hairline frame with rounded corners on the page background, with real space between panes instead of a two-pixel seam, and room around the text instead of the first character touching the edge.
- **The terminal has its own type.** iA Writer Mono, the same face the app uses for code and file paths, at the same size and line height as before so nothing reflows. If you have JetBrains Mono installed, which is what the terminal used before, it is still second in line.
- **Your terminal colours and the app's colours are finally two separate things.** Every one of the thirteen palettes now describes its terminal in one place, and the pane's own trim, its ground and its scrollbar are drawn from it. You can run a dark Mocha terminal on a light app, or the other way round, and neither leaks into the other.
- **The panel header above each terminal is quieter**: a shorter band, no coloured underline on the pane you are working in, and the same greys as the rest of the app.
- **The pane stopped animating while a session starts up.** It had a three-second colour cycle that, since an earlier release, cycled between four identical colours.

### Notes for the next release

Scrolling up in a terminal still only reaches what that terminal has drawn since you opened it. Reaching further back, into the conversation the assistant recorded, is the next piece.

## [1.3.0-alpha.21] - 2026-08-13

Nothing in the app blinks at you any more. The four screens the restyle had not reached yet, the session panel, project notes, costs and settings, now look like the rest of it.

### Changed

- **Status dots have stopped pulsing, blinking and fading.** Every dot, chip and badge that reports what something is doing is now a still shape. A running session is a filled dot; a session waiting on you is an outlined one, which is a difference you can see without relying on the colour, and which does not move. The `Needs input` label on a pane, the file-conflict count and the machine pill all sit still too. The one thing that still moves is a spinner on a button you just pressed, which is telling you about an action rather than about a state.
- **The session panel is a proper side panel.** It used to take half the height of the page and push the session list into whatever was left; on a stopped session it took the whole thing. It is now a 420px column down the right-hand side, so the list you opened it from is still there and still clickable. Its properties are laid out on one aligned column instead of inside a striped box, the title is a real page title, and the two facts it never showed, which assistant the session belongs to and which model, now have rows of their own.
- **The session panel has a notes field.** A plain, borderless place to write something about a session, kept per session in this browser. It is not synced anywhere and it does not appear in search.
- **Opening the panel drops two columns from the Sessions table** rather than squeezing seven into the space left over, which was cutting `Claude` down to `Claud`. Project and Model step aside; both are in the panel you just opened.
- **Project Notes reads like a document.** A 720px column with generous empty margins, headings that look like headings, and notes, goals and checklist items on a rhythm where a run of items sits closer together than a run of paragraphs. Highlighting an item no longer paints a bar across the whole row.
- **Costs is a page instead of eight boxes.** The four figures at the top keep a hairline around them; the chart, the two breakdowns and the session table lost theirs and became sections with labels. The four headline numbers stopped being four different colours, because a total spend is not more green than a token count. The session table is the same table the Sessions view uses.
- **Settings is a list, not a stack of buttons.** Each setting is a row separated by a hairline, with the switch on the right; the rows no longer light up when you pass the pointer over them, because there is nothing to click except the switch. The category rail on the left is wider, in normal sentence case rather than forced lower case, and its selected item no longer changes colour with your terminal theme.
- **The account button shows how much of your session allowance is used** rather than when it resets. The reset time is still in the panel underneath it.

### Fixed

- **A session with no cost tracking showed an em dash inside a dashed box**, which read as an empty field waiting to be filled in. It is now just a quiet dash, with the explanation on hover. Nothing about a session that cannot report a cost should look like a control.
- **The carets beside each Project Notes section rendered as blue rounded squares** on Windows, because the arrow character is treated as an emoji by default.
- **The Costs title did not line up with anything underneath it**, sitting 32 pixels to the left of the first card.
- **The conflict badge printed near-black text on yellow** in light mode, which was the wrong way round.

### Notes for the next release

The four screens above are desktop work. On a phone they still use the old layout, which is the next piece of this. The terminal itself is also untouched so far.

## [1.3.0-alpha.20] - 2026-08-13

Codex sessions stop lying to you. Your transcripts were missing nearly half of what happened in them, your search results were labelled with raw identifiers, a session with 226 million tokens against it was displayed as costing `$0.00`, and new Codex sessions took minutes to appear because the code watching for them could never match a real filename.

### Fixed

- **Codex transcripts were dropping 43 percent of the conversation, silently.** Codex moved to a new way of recording tool calls some months ago and the reader was never taught about it, so every command it ran and every result that came back was thrown away without a warning, a log line or a gap in the page. On one real session the transcript showed 493 entries where there were 3,757. Everything that was being dropped is back: 3,264 recovered entries on that session, and 431 of the 493 that did survive are unchanged, with the other 62 no longer blank.
- **Tool results that came back as several pieces rendered as nothing at all.** A result that arrived in parts, rather than as one block of text, produced an entry with no text in it. That has been true for the older kind of tool call as well, so this was quietly emptying entries in Claude-era Codex sessions too. Images returned by a tool are now announced as `[image]` rather than being dropped, and their data is never pulled into the page; one of them was 671 KB.
- **A very long session showed nothing.** The heaviest session on the test machine has a 924 MB record, and reading it whole exceeded a hard limit in the runtime, so the reader gave up and returned an empty transcript with no explanation. Long records are now read from the end, up to a quarter of a gigabyte, and the app says when it has done that. That 924 MB session now shows 39,880 entries.
- **Codex cost showed `$0.00` instead of saying it does not know.** The cost reader only understands Claude's format, and nothing checked whether the session it was handed was a Claude one, so every Codex session reported zero. Codex is billed against a ChatGPT plan rather than per token, so there is no honest dollar figure to show. The app now says so plainly and shows the real token count instead: for that same session, 226,420,778 tokens, with the cache reads separated out.
- **Search results were labelled with raw identifiers.** Search looked for a title in one place that turns out to exist in under two percent of session files, and printed a 36-character identifier for the rest. It now uses the same title the sidebar shows. On the test machine that is a real title for all 3,036 sessions.
- **New Codex sessions took minutes to appear.** The code watching for new session files was checking names against a pattern that no real filename has ever matched, because of a single letter in the timestamp. Every file event was discarded and the app fell back to a five-minute sweep. Sessions now appear within seconds. Archiving a session in the Codex app is noticed too, and so is anything you do in the app itself that never touches a file: renaming a thread, starting one, moving one.
- **"Summarize to Docs" has never worked.** Two pieces of code were registered to answer the same request and only the first ever ran, so the one that writes a summary into your project notes was unreachable. It is reachable now.
- **Summarizing a Codex session returned "not found".** It looked for the conversation in Claude's folder and nowhere else.

### Added

- **The app now notices when Codex changes its format.** Every line it does not recognise is counted and reported, with the shapes named. The next time the format moves, the app says "these lines were an unrecognised shape and were dropped", instead of rendering short and saying nothing. Two new record types found during this work are already accounted for, so the counter stays quiet until something genuinely new arrives.
- **Codex plan and rate-limit information** is now read alongside the token counts, ready for the usage display.

### Known

- **Roughly six percent of Codex sessions are large enough to be read from the end rather than in full.** The app tells you when that happens. The alternative was holding half a gigabyte in memory to display a page.
- **Codex sessions show tokens where Claude sessions show a cost.** This is deliberate. There is no per-token price for a plan-billed product, and inventing one would be the same mistake as the zero it replaces.

### Testing

- 89 test files and roughly 1,500 assertions, all green. This release adds five files with 71 assertions covering the recovered record types, the drift counter, the token readers, the cost gate, the duplicate-route fix, search titles and the watcher.
- All 18 mechanical gates pass.
- Everything was measured against the real Codex data on this machine, read-only. A harness wrapped every write path in the runtime and recorded zero write attempts against the Codex directory over a full pass, with a control window proving the directory changes on its own while the app does nothing.

## [1.3.0-alpha.19] - 2026-08-13

The workbook was showing you 52 of your roughly 125 Codex conversations, and only half of those had a name. This release reads the same place the ChatGPT desktop app reads.

> Version note: alpha.16 and alpha.18 are reserved for two phases of the terminal work that have not shipped yet, so the numbers are not consecutive.

### Added

- **Every Codex conversation the desktop app shows, the workbook now shows.** It reads the app's own thread store rather than reconstructing the list by walking files. 52 sessions became 128, and 27 named became 128 named.
- **Titles come from a cascade of five sources**, ending in a shortened first message, so a session is never a bare identifier.
- **Folders match the app's.** Codex groups conversations by their working directory, and two spellings of the same directory used to appear as two folders. They collapse into one, and a Claude folder and a Codex folder for the same directory are one row.
- **Conversations stored outside the Codex folder are reachable**, including two on a second drive that the old file walk could never have found.

### Changed

- **Discovery went from 3.1 seconds to 22 milliseconds** on a warm cache, and finding one conversation's file went from 993 milliseconds to 19.
- **The model and effort pickers describe reality.** The saved list of reasoning efforts omitted the three that account for 98 percent of actual use, and silently dropped them.

### Known

- **The file walk is still there and still runs.** It is the only thing that works on a machine where the Codex app has never run, and it fills in anything the store has not recorded.

## [1.3.0-alpha.17] - 2026-08-13

Terminal panes stop redrawing wrong after a long absence, and two people on one session stop fighting over its size.

> Version note: this phase shipped its code earlier and is being recorded now; alpha.16 belongs to a phase that has not shipped.

### Fixed

- **A pane that had been in a full-screen program for hours came back as a few patches painted onto a blank screen.** The server was replaying a log of everything written to the terminal, pruned from the front, and the pruned part contained the instruction that set the screen up. It now replays a description of the screen as it currently is, which has no beginning to lose.
- **Two devices on one session fought over its width.** A phone and a desktop each claimed the size, every claim made the terminal repaint everything into both streams, and the result was a repaint storm rather than a wobble. Handing a session over is still instant; only an oscillation is throttled.
- **A pane that had been sitting in a full-screen program did not know it.** The server now tells every client the mode it is in on arrival and whenever it changes, so the keyboard behaves correctly straight away.

### Added

- **Deeper scrollback than the terminal keeps.** The server now retains a paged log of completed lines behind the 5,000 the browser holds.

### Known

- **The new machinery can be turned off** with environment switches if it misbehaves, and the old replay path is retained in full underneath it.

## [1.3.0-alpha.15] - 2026-08-13

The previous two releases rebuilt the furniture and the controls. This one rebuilds the rooms, and answers the thing you actually asked for: finding your most recent session is now the easiest thing in the app rather than the hardest.

### Added

- **Recent sessions are everywhere you would look for them.** Press `Ctrl+K` and hit Enter: that opens the session you were last working in, whichever assistant it belongs to. There is a `Recent` section at the top of the sidebar with the last five. The empty workbench offers `Continue where you left off` with the last four as cards. The Sessions view sorts by last activity by default. All four read the same list, so they always agree on what is most recent, and Claude and Codex sessions interleave properly by time instead of sitting in separate piles.
- **Quick Find used to show nothing useful when you opened it.** It sorted whatever the current view happened to be showing, which in the workbench was nothing at all, and it never showed a Codex session the app had not adopted. It now opens on the eight most recent sessions across everything on the machine, with the first one already selected.
- **The Sessions view has a `Last active` column**, and every column sorts. Your choice is remembered.
- **The top bar tells you where you are.** `Myrlin / Sessions`, or `Myrlin / Workbench · Main` when you are in a tab group. The view tabs tell you what is available; they never told you what was showing.

### Changed

- **The Sessions view is a real table.** It was a list of cards: about six fitted on screen, and every one of them repeated the same three facts in a different arrangement. It is now seven columns at Notion's own measured density, roughly eighteen rows on the same screen, with the project, the assistant, the status, the model, the cost and the last activity each in their own column. On a phone each row folds back into a card.
- **Menus and dialogs are one menu and one dialog.** Every context menu, popover, dropdown and modal in the app now shares one shadow, one corner radius and one 150ms fade. Menus are 240px with 28px rows and a check mark in the icon slot for the selected item, instead of a highlight.
- **Dialogs stopped blurring the page behind them.** The frosted-glass backdrop was the most expensive thing on screen while a dialog was open, because it forced everything behind it, including any live terminal, to be re-rendered on every frame. It is now a plain dim.
- **Every tab in the app is a pill.** The terminal group tabs lost the coloured bar underneath them and took a coloured dot instead; the tasks, docs and account tabs lost their underlines; the filter and period buttons stopped looking selected when you merely hovered them.
- **Panes are framed rather than striped.** A pane belonging to Claude or Codex used to carry a thick coloured bar across the top, another across the bottom, and a coloured wash over the whole thing. It now has a single hairline in that assistant's colour all the way round. The same applies to the per-slot colours, which were drawn twice from two different colour tables that had drifted apart.
- **The agent board columns have no background until you drag a card over one**, and then the whole column lights up rather than just the part with cards in it.
- **Notifications appear at the bottom left instead of the bottom right**, where they no longer land on top of the session detail panel or the account menu.
- **Nothing shouts any more.** Forty-six all-capitals labels became sentence case. Exactly one remains, the `Recent` heading in Quick Find, which is deliberate.
- **Loading placeholders shimmer instead of flashing.** The old one pulsed the opacity of a block of your text colour, which on a light theme was a blinking near-black rectangle.

### Fixed

- **Hover highlights no longer flash under the pointer while you scroll or drag.** 126 rules now wait until the pointer is actually resting.
- **The worktree task dots have never worked.** The code that renders them put the attribute inside the class name by mistake, so the browser never saw it: the "busy" pulse, the "waiting" fade and the "ready" tick have been invisible since they were written. All three now appear.
- **Rows you can click can now be reached with the keyboard.** Session rows, project rows, board cards and task items are focus stops and respond to Enter and Space. They had focus rings drawn for them last release with no way to focus them.
- **The empty workbench no longer draws its icon in a shadowed rounded box**, which was the last raised element on the default screen.
- **Loading placeholders across the whole app were being sized by a rule meant for one card**, because the same class was declared twice and the wrong one won.
- **The login screen dropped its purple graph-paper background.**

### Known

- **Two all-capitals labels remain in the mobile action sheet.** They live in the phone stylesheet, which belongs to the mobile work still to come, and will be swept with it.
- **The contrast items recorded in the previous release are unchanged** and are still scheduled for a single decision before this work is called finished.

### Testing

- The suite is green at 83 files and 1402 assertions. This release added one test file with 28 assertions covering the recency merge, executed against fixtures rather than read from the source, and retargeted three existing expectations, two of them pre-authorised.
- All seventeen mechanical gates pass. Blurred backdrops fell from 6 to 0, gradients from 5 to 1 (the loading shimmer, which is a gradient by nature), all-capitals labels from 49 to 3, raw colour values outside the token block from 71 to 46, and leftover palette references from 1021 to 902.
- Eight screenshots at two sizes in both light and dark are recorded under `screenshots/notion-restyle/p4/`.

## [1.3.0-alpha.14] - 2026-08-13

The last release moved the furniture. This one replaces the things you actually click. Buttons, fields, checkboxes, switches, tags, status chips and progress bars all stop being thirteen slightly different components and become one of each. The purple buttons are gone.

### Changed

- **There is one accent colour on a button now, and it is blue.** `Start session`, `New`, `Save` and every other confirming action used to be filled with the terminal palette's purple, which changed shade every time you switched terminal theme and was the loudest colour on the screen. They are now the design system's blue. There are exactly two button weights in the whole application: a filled blue one for the action you probably want, and a quiet white one with a hairline for everything else. There is no third colour and no filled red button, because a red rectangle is an alarm and a `Stop` button is a choice: dangerous actions now say so in red text on an ordinary control.
- **Every button is the same size.** They were 13px text in 8px by 16px padding, which worked out to about 33px, except the ones that were 27px, and the two in the empty workbench that were 38px. They are all 28px now, with small ones at 24px and the little icon buttons in a pane header at 26px. Icon buttons grow to 44px on a touch screen.
- **Buttons stopped shrinking when you press them.** The whole family scaled down to 97 percent on click, which blurs the label for the length of the press. A press is now a slightly darker background, which is what the rest of the interface already did.
- **Every text field is the same field.** Fourteen of them: the login box, the settings search, Quick Find, the project search, find-in-conversations, the task search, the number inputs, the dialog forms, the schedule dropdowns. They had eleven different heights, six different corner radii, and four different focus colours between them, three of which were the old purple. They are now 28px with an 8px inset, a hairline border, and the design system's blue focus ring, which draws just inside and just outside the edge so it hugs the corner instead of boxing it.
- **Checkboxes are blue and all three are the same size.** They were purple, and they were 14px in one place and 16px in another.
- **The settings switches are the design system's switch**: 26px by 16px with a 12px white knob that slides, on a track that turns blue. They were 36px by 20px with a purple track and a knob the colour of your body text, and the whole track used to change shape as it moved.
- **Tags, models, costs, ports, providers and plans are all the same kind of chip now**, and they are a different kind of chip from a status. This distinction is the point: a property chip is a small 4px-cornered thing with a translucent tint, so it sits correctly on a white row, a hovered row or a coloured panel with no special handling; a status chip is the same thing at a pill radius with a dot in front of it. They used to be 10px monospace pills in fifteen percent tints of their own text colour, which is close to invisible, and they used the same shape as a status.
- **Status dots are 7px and they no longer glow.** A running or waiting session pulses gently instead, and under the "reduce motion" system setting it simply holds still rather than animating at all.
- **A running session is green.** It was drawn with a green background and blue text, because two halves of the colour table disagreed with each other. Green everywhere now. Complete stays teal, which is a different state and now looks like one.
- **Progress bars are one component with five users**: the account usage meter, the header meter, the token breakdown, the system resource gauges and the cost share column. Same 5px height, same track colour, same green, amber and red thresholds.
- **The notes editor and the raw markdown editor have no box around them.** They are page content, not form fields, which is how the design system draws a note. The notes editor also stopped setting your prose in a monospace font.
- **Form labels are sentence case** instead of spaced-out capitals.

### Fixed

- **Keyboard focus rings were being cut off.** Five parts of the interface clip whatever is inside them: the sidebar, the settings navigation, the Quick Find results, a board column, and the Codex status strip. A focus ring is drawn just outside the edge of a control, so anything focused inside one of those five lost part of its ring, and a full-width sidebar row lost both ends of it entirely: you saw two short dashes and no control. Twenty controls in those five places now draw the ring just inside their own edge, where nothing can cut it.
- **Every field that switched its focus ring off now has one back.** Nine of them turned the ring off permanently to draw their own border tint, which is not a focus ring, and one of them drew nothing at all.
- **The interface survives Windows High Contrast.** Everything this release drew is a filled shape, and High Contrast throws away filled shapes, so without this a chip would have been invisible text, a status dot would have been nothing at all, a switch would have been an empty rectangle, and the confirming button in a dialog would have looked exactly like the one that cancels. Buttons, chips, dots, fields, the switch and all four progress bars now keep a visible edge, and the confirming button, the "on" switch and the filled part of a progress bar take the system's own highlight colour.

### Known

- **Two colours in this release do not meet the contrast standard, and both are the design system's own.** The white label on the blue button measures 3.9:1 where 4.5:1 is the bar for text, and the red used for dangerous actions measures 4.3:1. Darkening either one would mean shipping a colour the design system does not contain, so both are recorded with their measurements and a decision on them is scheduled before this work is called finished. Neither colour is ever the only signal: buttons always carry a verb, and a `Stop` button says `Stop`.
- **The yellow "waiting for you" dot measures 2.7:1** against a white page, below the 3:1 bar for a graphic. It pulses, and the chip next to it says `Needs input` in words, so the colour is never carrying the message alone.

### Testing

- The suite is green at 82 files and 1368 assertions. This release added and removed no test expectations and retargeted two, both of them pre-authorised: one Codex status colour and the three progress-bar threshold colours.
- All seventeen mechanical gates pass. Leftover palette references fell from 1127 to 1021, raw colour values outside the token block from 82 to 71, all-capitals labels from 52 to 49, and the High Contrast rule set grew from 5 selectors to 38.
- Eight screenshots at two sizes in both light and dark are recorded under `screenshots/notion-restyle/p3/`.

## [1.3.0-alpha.13] - 2026-08-13

This is the one you can see. The previous release changed what the interface was made of; this one changes where things sit. The header is half the height it was, the sidebar is narrower and warmer, rows are tighter, and the coloured bars, glows and lifts are gone. If you know Notion, you should recognise the shape of this.

### Changed

- **The top bar is 44px instead of 80px, and it no longer looks like a title bar.** It has no background of its own, so the page runs all the way to the top edge and a single hairline is the only thing separating the bar from the content. Every control in it came down to one size, the logo mark went from 64px to 20px and lost its purple halo, and the view tabs stopped being a raised segmented control: the active view is now marked with a quiet selection wash and heavier text, the same way the sidebar marks the row you are on. The two navigations finally agree with each other.
- **The sidebar is 240px, and its background is warmer than the page rather than darker.** That is the single biggest reason the old sidebar read as a tool panel and the new one reads as part of the document. Its right edge is a hairline drawn inside its own width, so dragging it to resize behaves exactly as before.
- **Sidebar rows are 27px tall instead of 39px**, which is roughly a third more of your projects on screen without scrolling. Hovering a row no longer makes its border blink in and out, and on the light themes the hover highlight is now actually visible: it used to be a white tint on a light background, which is to say invisible.
- **Every coloured bar down the side of a row is gone.** The selected workspace had one, every session row had one in its provider's colour, the active provider tab had one underneath it, and grouped workspaces had a thick one. In their place: the workspace colour moved to the dot that was already next to it, the provider colour became a tint on the row you are pointing at, the active tab became a pill, and a grouped row is now outlined rather than bracketed. This is the single most important change in the restyle and it is why the sidebar suddenly looks calm.
- **Section labels are sentence case.** `PROJECTS` and `DISCOVERED` in spaced-out capitals are now `Projects` and `Discovered`, at a readable size. The two hairlines that flanked the Discovered label are gone too; sections are separated by space, not by rules.
- **"New session" is a row, not a button.** It used to be a dashed outline with grey text on a grey fill, which was hard to read even before the restyle. It is now the same kind of row as everything else in the sidebar.
- **Nothing lifts, floats, glows or scales any more.** The login mark stopped bobbing up and down and pulsing; buttons stopped growing halos when you hover them; cards stopped rising off the page; status dots stopped glowing. Depth now exists only where something genuinely floats above the page: menus, popovers, dialogs and toasts. The page itself is flat.
- **Corners are consistent.** 199 hand-written corner radii across the stylesheet became eight named ones, so a chip and a card are no longer accidentally the same shape. Chips are 4px, cards and dialogs are 10px, buttons are 6px.
- **Scrollbars are the thin, quiet kind**: a 7px hairline thumb over a transparent track, darkening slightly when you point at it.
- **Selected text outside the terminal is the blue wash from the design system**, in every one of the thirteen palettes. The terminal's own selection is unchanged and still follows the palette you picked.
- **Project dots, tab dots, folder colours and tag chips stopped following your terminal palette.** Picking a terminal theme used to repaint half the sidebar with it. Those marks identify a project, a tab or a tag, and an identity colour that changes when you change something unrelated is not an identity colour, so they now come from the interface's own ten-colour palette and look the same in every terminal theme, light or dark. The colours you have chosen are untouched: a project saved as purple is still purple, a tag keeps the colour it has always had, and the tab colours still run in the same order down the tab strip. Only the exact shade moved, from the terminal's saturated version to the quieter one the rest of the interface uses. Tag chips also gained a proper background rather than a fifteen percent tint of their own text colour, which was close to invisible in dark mode.

### Fixed

- **Muted text is readable again.** A token that was meant for disabled controls was being used for 29 different labels, hints and captions across the account panel, the search results, the usage meters, the Codex status strip and the mobile column headings. None of those are disabled; they are live text, and at that colour they measured roughly 1.9:1 against a white page where the readable floor is 4.5:1. They now use the ordinary quiet-text colour.
- **Context menus land where they should.** The menu animated in from 95 percent scale, and the code that keeps a menu from falling off the edge of the screen measured it during that animation, so it was positioning menus from a size that was never real. Menus now fade in with a 4px drop and nothing else, which is measurable from the first frame.
- **Seventeen controls had no keyboard focus ring at all**, including the settings search, the Quick Find inputs, the project search, the find-in-conversations box, the launcher search and the notes editor. Several of them switched the ring off permanently rather than only while clicking. Every one of them shows a ring on keyboard focus now, and controls that already had their own focus treatment keep it.
- **Two colour bugs that predate the restyle.** Row hover highlights on the three light themes were painted in white and were therefore invisible, and the grouped-workspace stripe used a colour that did not exist in most themes. Both now come from the theme system.
- **The colour picker was previewing colours it was not going to give you.** Choosing a project colour showed you the terminal palette's version of each swatch while the dot it fed was about to be painted in the interface palette. Picker and dot now resolve through the same table, so what you point at is what you get.
- **The top bar's shadow while you scroll now actually appears.** It was written, including its deliberately slow 700ms fade, but nothing ever switched it on.

### Removed

- **The colour-cycling glow around a loading pane.** It cycled a pane's border through purple, blue and teal with a halo at each step. The loading signal it duplicated, the pulsing dot next to the pane title, is still there, now in one neutral colour.
- **The purple halo behind the empty workbench**, and the purple drop shadows around the login mark.

### Testing

- The full suite is green at 82 files and 1317 assertions, unchanged: this release added, removed and retargeted zero test expectations. Every one of the seventeen mechanical gates passes, and four of the counters moved in the right direction: corner-radius literals 199 to 0, hover lifts 21 to 17, raw colour values outside the token block 128 to 83, and leftover palette references 1229 to 1132.
- Eight screenshots at two sizes in both light and dark are recorded under `screenshots/notion-restyle/p2/` for comparison against the previous two releases.
- The three items above that landed after the release commit (the colour maps, the picker, the scrolled top bar) added 51 assertions and retargeted none, and are photographed separately under `screenshots/notion-restyle/p2b/`. Across those eight shots the number of pixels painted in an exact terminal-palette accent colour is zero, down from 39562.

## [1.3.0-alpha.12] - 2026-08-13

This is the first prerelease of the Notion restyle you can actually see. The application turns warm and light, the type stops being a webfont, and the whole colour system moves onto a new foundation. Nothing has moved on screen yet: the header is still the same height, the sidebar is still the same width, and every panel is still where it was. That is deliberate. This release changes what things are made of; the next one changes where they sit.

### Changed

- **The application has a light theme and a dark theme of its own, separate from the terminal palette.** Until now the thirteen Catppuccin palettes coloured everything: the terminal, the sidebar, the header, every button. Those thirteen are excellent terminal palettes and they are all still here, unchanged, still switchable from the same picker. What changed is that the chrome around the terminal stopped borrowing from them. The chrome now has two themes of its own, light and dark, taken from the captured design system, and they are chosen independently. A light terminal palette on dark chrome is a legal combination and it works. The chrome theme is remembered between visits and, on a first visit, follows the same system light or dark preference the palette already followed, so a new profile always gets a matching pair.
- **Text is warmer and easier on the eye.** Body ink in light is a warm near-black rather than a blue-grey, and in dark it is a warm off-white rather than a cool lavender-white. Neither is ever pure black, which is the single most common cause of eye strain in a light interface.
- **The interface font is now your operating system's own UI font.** It was Plus Jakarta Sans, fetched from Google. The design system this restyle follows ships no webfont for application chrome on purpose, because a webfont on an application surface is instantly recognisable as not-native on both macOS and Windows. Code, file paths, ids, branch names and diff hunks now set in iA Writer Mono, which is served from this application rather than from anywhere else.
- **The status colours gained a distinction they were missing.** A completed session is now teal and a running session is green. They used to be the same green, which meant the sidebar dots, the table chips and the attention list could not tell you which of the two you were looking at.

### Removed

- **The last external request is gone.** The application no longer contacts fonts.googleapis.com or fonts.gstatic.com, or any other outside origin, on any page load. That was the only one, and it was a blocking round trip on every cold start. On a LAN, behind a tunnel or on an aeroplane it was a delay for a font that was never going to arrive. The two font families that still ship are served from this application and their licences permit it. A test now fails the build if any external font request comes back.

### Fixed

- **Stylesheet changes reach your browser again.** The two main stylesheets carried no cache-busting version at all, so a change to either of them shipped stale to anyone with a warm cache. Since this restyle is almost entirely stylesheet changes, that would have meant most of it silently not arriving. Every asset the page loads now carries a version and they all move together.
- **The browser acceptance test can pass again.** Two of its assertions still expected script versions from before the Select v3 and mobile-select work landed, so the whole browser lane failed before the restyle touched anything. Recorded during the baseline pass, fixed here as part of the version bump.

### Testing

- The token parity gate is now load-bearing. It compares 319 design tokens between the application stylesheet and the captured design bundle on every run, per theme, and fails on any single value that drifts. Before this release it had nothing to compare and passed trivially.
- Five test expectations moved, each in the same commit as the change that moved it, each with the reason written next to it, and none of them deleted: the provider identity colours, the Copy view font, and the asset versions in three files plus the browser lane.

## [1.3.0-alpha.11] - 2026-08-13

This prerelease changes nothing you can see. It is the scaffold the Notion restyle is built on: the design bundle is vendored into the served tree, the before pictures are captured, and the mechanical floor that keeps the restyle from breaking the app is now enforced by the test suite.

### Added

- **The captured Notion design bundle now lives in the served tree**, at `src/web/public/design/notion/`: the five token files, the machine-readable token provenance, the component paint layer, and the two font families. Nothing links to any of it yet, and the token files deliberately never will be. The reason is a real trap: the phantom-token gate treats `styles.css` and `styles-mobile.css` as the only places a custom property can be defined, so a token defined in a vendored file and used in `styles.css` would turn CI red and, worse, would silently do nothing in the browser. So the raw values get authored into `styles.css` instead, and a new test diffs the two copies on every run so the duplication cannot drift apart in silence.
- **A screenshot harness that captures the whole application at two sizes in both light and dark**, into `screenshots/notion-restyle/`. It boots the real application against a disposable sandbox on a random port, signs in with a one-use token, seeds an invented set of projects and sessions so the pictures show real rows rather than empty states, and records the numbers each later phase has to hit: header height, sidebar width, body ink, font stack. Every captured image is checked to be at most 2000px on both axes. It never touches your profile, your credentials or your sessions, and the credential refresh sweep is switched off before the server starts.
- **Thirteen mechanical gates, run as part of `npm test`.** They protect the things a restyle breaks by accident: 378 element ids, 278 class names that JavaScript queries but that a designer would see no reason to keep, 46 `data-` attributes, and the guard rules that make hidden elements stay hidden. Alongside those, ten counters track the work still to do (radius literals, gradients, uppercase labels, leftover palette colours) and fail if any of them moves the wrong way. Run `npm run gates` to see the current state.
- **A decision log, an inventions log and a deviations log** under `docs/design/notion-restyle/`, plus the recorded starting measurements for every counter. Anything the restyle does differently from the captured brand gets a row with what the brand says, what shipped, why, and what it costs.

### Fixed

- **Nothing user-facing.** One correction worth recording: a scan for em dashes reported the codebase was clean. It was not, and the scan was wrong. There are 147 of them, two in text the app actually shows you. They are now counted, frozen so the number cannot grow, and queued for the copy pass.

## [1.3.0-alpha.10] - 2026-08-06

This prerelease changes when Select mode pauses output, and lets the Copy view read the whole conversation instead of only what fit on the screen.

### Changed

- **Select mode no longer freezes the pane the moment you turn it on.** Turning the mode on used to stop output immediately and swallow the scroll wheel, so a pane you only wanted to scroll looked hung: "when i toggle select, the window freezes and i cannot scroll or drag up". The pause is now part of the drag rather than part of the toggle. With the mode on and nothing selected the pane is fully live: output keeps painting, and the wheel works the way it does normally, scrolling the running app's own history under a full-screen CLI and the terminal's scrollback in a plain shell. Output pauses the instant you press the mouse to start selecting, which is what keeps the text from moving under the pointer, and it resumes as soon as the selection goes away, whether you click somewhere else, clear it, or start typing. Copying does not resume output, so the highlight survives the copy. A click that selects nothing releases immediately, and so does a drag that ended outside the pane, so the pane cannot get stuck paused.
- **The Select mode notice describes the new behavior.** It now leads with scrolling being available, ties the pause to the drag, and names both ways back to live output. The one-time copy hint was updated to match.

### Added

- **Copy view can copy the whole conversation.** The Copy view header gains a source switch. "Terminal" is unchanged and still copies what the terminal has shown, including the current screen. "Full transcript" reads the session's own transcript through the existing read-only session-mirror path, so it reaches the entire conversation, including everything an interactive CLI kept inside its own interface and never wrote to terminal scrollback. Turns are labelled by role, tool calls and results collapse to one line each so the copy stays readable, and a "Load earlier" control pages further back until the beginning is reached. Copy all copies whatever is loaded, and Refresh fetches the current end of the conversation. It is a snapshot and it never touches the running session: the mirror path only reads the transcript file, and the subscription is released as soon as the snapshot is taken. If the session has no transcript yet, the transcript is empty, or the read fails, the Copy view says so inline and the Terminal source keeps working.

### Testing

- Existing freeze tests were updated to the new semantics rather than removed: what asserted freeze-on-toggle now asserts live-on-toggle plus freeze-on-drag-start plus release-on-selection-clear. New executed coverage drives the real mouse interceptor through complete gestures, including the ordering that matters (the pause starts before the click reaches the terminal), a click that selects nothing, a drag that ends outside the pane, intermediate selection updates during a drag, and copying.
- Added transcript coverage: rendering from a stubbed history payload including role labels and one-line tool summaries, the snapshot opening and immediately closing its subscription, "Load earlier" paging backward and prepending, exhaustion hiding the control, and every gated failure path (endpoint error, no session identity, empty transcript) leaving the Terminal source working.

## [1.3.0-alpha.9] - 2026-08-06

This corrective prerelease fixes a field report: Select mode switched itself off as soon as the pointer moved over the terminal.

### Fixed

- **Hovering over the terminal no longer cancels Select mode.** An interactive CLI turns on any-event mouse tracking, so moving the pointer across the terminal with no button held makes the terminal emit a stream of mouse position reports on the same channel it uses for keystrokes. Select mode resumes live output on user input, so the first hover report switched the mode off before anything had been selected. Mouse reports are now recognised as terminal-generated, in both the SGR encoding that ships and the legacy encoding, and in both places the decision is made. They are still delivered to the session unchanged, because the CLI needs them for its own clickable interface; only the decision to resume output changed. Typing, clicking a link, pasting, and every other real input still resume live output exactly as before.
- **A burst of motion reports is no longer mistaken for typing.** Pointer motion produces reports continuously, and the terminal hands several of them over at once. The size limit on a machine-generated payload was tuned for one-shot reports and rejected a real hover burst, which is how the first fix missed this. A measured sweep produced 81 reports totalling 881 characters in a single gesture; the limit now covers that with room to spare, and anything beyond it still resumes output rather than being trusted.

### Testing

- Added mouse coverage to the report-filter truth table: hover motion, press, release, drags, modifier-varied motion codes, wheel, the legacy encoding and its truncated forms, a 40 report burst that exceeds the previous limit, and mixed chunks (a mouse report next to a printable or an arrow key) which must still resume output.
- Added an executed check that drives the production keystroke handler and the production socket wrapper with the exact bytes captured from a browser hover, proving the mode survives on both paths, that every report still reaches the session, and that a keystroke afterwards still resumes live output.

## [1.3.0-alpha.8] - 2026-08-05

This corrective prerelease fixes the defect that made Select mode cancel itself on the click that started a selection, and gives phones the two copy controls they could not reach at all.

### Added

- **Select mode and Copy view are reachable on a phone.** The pane header that carries both controls is hidden at phone widths, and its buttons were the only callers of either feature, so on a phone neither existed. Both now appear in the mobile toolbar next to Read and Copy, and both are also offered in the pane long-press action sheet. They call the same pane methods the desktop header buttons use, so the surfaces cannot drift. The toolbar Select button shows a clear active state and re-reads pane state whenever the mode changes without a tap, including when typing resumes live output, when the hold-queue overflow valve trips, when Escape closes the Copy view, and when a tab switch brings a pane back with the mode still remembered.

### Fixed

- **A focus report no longer cancels Select mode.** Windows ConPTY enables focus reporting on effectively every pane, so xterm emits a focus-in report through the same channel it uses for keystrokes whenever its hidden textarea gains focus. Select mode treats input as a request to resume live output, so clicking the toggle and then pressing the mouse down to drag turned the mode straight back off and selected against a repainting screen. Payloads that consist only of terminal-generated reports (focus in and out, cursor position responses, device attributes responses) no longer count as user input on either the keystroke channel or the socket. What reaches the session is unchanged; a chunk that mixes a report with anything else still resumes live output. The toggle also hands keyboard focus back to the terminal when it turns the mode on, so the first drag selects with no focus transition at all.
- **The Copy view covers the whole pane on a phone.** The overlay measured its top offset once, at creation, and fell back to a desktop header height when the header could not be measured. A hidden mobile header measures zero, so the snapshot started about 35px down and left a live, still repainting band of terminal above it. The offset is recomputed on every open, and a hidden header now means the overlay starts at the top of the pane.
- **Copy view buttons are big enough to tap.** Copy all and Refresh were 26px tall. Every control in the overlay bar is at least 40px on a phone-laid-out pane, and the sizing is re-applied on each open so a rotation between opens is honored.
- **A long press inside the Copy view selects text instead of opening the action sheet.** The overlay renders the transcript as ordinary selectable text, so a long press there is a selection gesture. It was opening the pane action sheet, which cancelled the selection and put Kill Session one tap away.
- **The Select mode notice no longer covers the mobile toolbar.** The notice strip is click-through, so on a phone it hid the toolbar while leaving it tappable, which read as the toolbar disappearing. It is now placed above the toolbar and the type-and-send row, re-measured on every show. On desktop it also stops painting over the pane's floating action buttons.
- **The copy hint and the Copy view button read correctly.** The one-time hint now names Copy view alongside Shift+drag and Select mode, and the icon-only Copy view button carries an accessible name rather than only a tooltip.

### Testing

- Added 32 checks to `test/terminal-select-v2.test.js` (78 to 110). The report filter is covered by a full truth table: focus in and out, concatenated bursts, cursor position and both device attributes forms, arrow keys, modified arrows, application-mode keys, printable text, control characters, bracketed paste, mixed chunks, empty, non-string and oversized payloads. The production keystroke handler and the socket hook are compiled from source and executed, proving a report is forwarded without resuming output while a keystroke, a mixed chunk and an unparseable frame all still resume it.
- Added executed coverage for the mobile work: overlay top offset across measured, hidden and absent headers, touch sizing applied and cleared, strip placement against a measured toolbar and its fallback, the toolbar injector including idempotency and ordering, the toolbar actions delegating to the pane methods, per-pane state mirroring including the self-exit case, and a fit re-placing the strip on the frozen early-return path (the reachable case where a remembered Select mode is shown before the pane becomes mobile-active).

## [1.3.0-alpha.7] - 2026-08-05

This prerelease makes terminal selection trustworthy under a full-screen CLI and adds a way to copy more than the visible screen. Version alpha.6 is claimed by a separate in-flight branch, so the gap here is expected.

### Added

- **Copy view.** A new button beside the Select toggle in each pane header opens an in-pane snapshot of that terminal as ordinary selectable text. While a full-screen CLI is running it composes everything the normal buffer still holds (the pre-app transcript plus shell scrollback), a `[ current screen ]` divider, then the live frame; otherwise it shows the normal buffer including scrollback. Runs of three or more blank lines collapse and trailing padding is trimmed, so a mostly-empty TUI frame reads as text. Native drag selection, Ctrl+A scoped to the snapshot, long-press on touch, Escape, Refresh, and a Copy all button that works on plain HTTP LAN origins are all available. It is a snapshot: the session underneath keeps streaming while it is open.

- **Panes claim terminal width when they become the one you are looking at.** One PTY is shared by every attached client and the backend gives geometry ownership to whichever client last typed or sent an explicit activate. Workbook already claimed on a pane click, a browser visibility change, a window focus, and a tab-group restore; a pane now also claims on two edges the app layer cannot see, its container crossing half-visible and the terminal taking keyboard focus without a click. That is what stops a phone from rendering frames laid out for a desktop. Claims are limited to one per 500ms, an unchanged viewport is not re-sent for 5 seconds, the pane fits before claiming so the stored viewport is the one it is about to apply, and no claim is made while output is paused for a selection or during the replay that follows a connect or a resync; a claim blocked by either is remembered and sent afterwards. The honest cost of a single shared PTY is unchanged: a desktop watching the same session then sees the narrow frames too, until it is interacted with again.

### Fixed

- **Select mode now pauses output while you select.** xterm anchors a selection to absolute buffer coordinates and only clears it on user input, scrollback trim, a row-count resize, or a buffer switch. A plain write leaves the selection in place while repainting the cells underneath, so a repainting CLI turned a valid highlight into stale text within a frame. Select mode now holds incoming output in the existing write queue instead of rendering it, so the screen being dragged over stops changing. Turning the mode off drains everything held in a single write.
- **Every input path resumes live output before it sends.** Typing, both paste listeners, Ctrl+V, Shift+Enter, the explicit Paste action, and app-driven commands leave Select mode first, so the echo lands on a current screen rather than behind a frozen one. The pane's own socket enforces the same rule for input frames built elsewhere, notably the mobile toolbar keys and the mobile type-and-send row, so tapping Send on a phone can never leave the answer stuck in the queue. Copying with Ctrl+C deliberately does not unfreeze, so a copy never disturbs the selection it is reading.
- **A wheel notch can no longer repaint the screen under a selection.** With mouse tracking active xterm forwards the wheel to the session and offers no Shift bypass. While Select mode is on the wheel is swallowed in the alternate buffer, where there is no scrollback to reach anyway, and translated into local scrolling in the normal buffer so shell panes still scroll while selecting.
- **Resync and resize can no longer strand a frozen pane.** A reconnect and a server-initiated reset both drop the freeze before `term.reset()`, because the scrollback replay that follows re-sends everything. A container resize during a freeze is deferred and applied after the drain, since a row-count change would clear the selection outright. A pane detached into a cached tab group stops holding output and drains, and a 2MB cap on held output resumes the stream and says so.
- **A remembered Select mode no longer hides its own scrollback.** The server sends a reset marker plus a full replay on every attach, the first one after a refresh included, so a pane that restored the toggle from a previous visit would have held the screen it was being handed. The freeze is now suspended for the replay window that idle detection already trusts, then resumes. Turning Select mode off is still the user's decision alone: a reconnect no longer rewrites the stored per-session preference.

### Testing

- Added `test/terminal-select-v2.test.js` (78 checks) with executed proofs of the freeze gate, the single-write drain and its ordering against the deferred re-fit, the real server-reset branch, the host-detach drain, the socket input hook, the overflow valve, all three wheel delta modes and both buffer types, and snapshot composition across the alternate and normal buffers, plus scoped source gates on every input path and both teardown paths.
- Added width-claim coverage in the same file: the debounce, the identical-geometry suppression and its expiry, the freeze deferral and its replay, the quiet-window retry and its single-timer discipline, closed-socket and send-failure paths, and a stub observer proving only the hidden-to-visible edge past the ratio claims.

## [1.3.0-alpha.6] - 2026-08-05

This prerelease keeps the server alive when the native terminal engine cannot load, instead of crashing or half-booting (issue #68).

### Fixed

- **The server no longer crashes or half-boots when node-pty fails to load (issue #68).** node-pty ships prebuilt binaries only for macOS and Windows, so on Linux it must compile during install; modern npm blocks dependency install scripts by default, and stale npx caches can hold an unbuilt binary. Previously the top-level `require('node-pty')` threw, the throw escaped into the store's `uncaughtException` handler (which flushes state but does not exit), and the process was left half-alive: the HTTP port was bound but the scheduler, credential watcher, schedule routes, and shutdown cleanup were never wired. The load failure is now contained at a single choke point in `pty-manager.js`: `pty` stays null, every spawn path fails per-call with a stable coded error (`PTY_NATIVE_LOAD_FAILED`) instead of a raw TypeError, and the WebSocket handshake for a terminal is closed cleanly with `1011 PTY_UNAVAILABLE`. The rest of the app reaches its normal ready state with only the in-app terminal panes disabled.

### Added

- **`GET /api/health` reports terminal-engine capability.** The public health payload now includes `pty: { available: true }` or `pty: { available: false, code: "PTY_NATIVE_LOAD_FAILED" }`. The endpoint exposes only the boolean and the stable code; raw error strings, filesystem paths, and usernames stay in the server logs.
- **In-pane degraded banner.** When the server closes a terminal WebSocket with `PTY_UNAVAILABLE`, the pane renders a persistent Catppuccin-themed banner ("Terminal engine unavailable on the server") instead of reconnect-looping, and the banner is cleaned up on pane dispose without stacking duplicates.
- **Remediation diagnostics.** A new `src/web/pty-diagnostics.js` module is the single source of truth for the availability probe and the platform-specific remediation text. On a degraded boot the server prints a prominent console banner with the exact toolchain, install-script-approval, rebuild, and npx-cache-repair steps for the host platform.

### Testing

- Added `test/pty-degrade.test.js`: unit coverage for the availability probe, the sanitized health field (both states, no path leak), the `1011 PTY_UNAVAILABLE` attach close, empty read-only method results, the coded spawn throw, the platform remediation text, and an em-dash absence gate; plus a route-level check that `/api/health` carries the pty field.


## [1.3.0-alpha.5] - 2026-07-27

This corrective prerelease closes the remaining explicit terminal-copy failure found in the live embedded browser.

### Fixed

- **Right-click Copy no longer trusts a false-positive legacy result.** Some Chromium/WebView hosts return `true` from `document.execCommand('copy')` without changing the OS clipboard. Workbook still makes that synchronous attempt first for insecure LAN origins and denied-permission fallbacks, but a secure origin now invokes `navigator.clipboard.writeText` in the same trusted click even when the legacy command claims success. A legacy result is accepted only when its synchronous `copy` event handled the explicit payload; if both paths fail, the menu now reports failure instead of a false success.
- **The insecure-origin fallback supplies and verifies its payload explicitly.** The temporary textarea handles the synchronous `copy` event, writes the exact plain-text value through `ClipboardEvent.clipboardData`, prevents the browser default, and records the handled event before cleanup. This keeps plain-HTTP remote access independent of the async Clipboard API without trusting an advisory command result.
- **Terminal focus and selection survive menu Copy immediately.** The menu starts both clipboard attempts while the trusted click is live, then synchronously refocuses the exact pane and restores the public xterm range if focus cleared it. Ctrl+C therefore works even while a permission prompt is pending, and later promise settlement cannot overwrite a newer selection.
- **Select mode survives refresh for the same terminal.** Workbook remembers an explicit Select-mode choice per session, so refreshing the authenticated public app no longer silently turns ordinary drag-to-select back into TUI mouse input. Other panes remain in clickable mode unless the user enables selection there.
- **Fresh browsers receive the repair.** Terminal, shell, and mirror scripts use a new cache token.

### Testing

- Added VM coverage for a truthy no-op `execCommand`, the dual-failure cross-product with a denied modern write, insecure origins, exact fallback payloads, truthful toasts, and synchronous focus restoration.
- Added real Chromium coverage in both the terminal interaction fixture and the complete Workbook shell. The terminal fixture now enables Select mode, reloads the page, and proves plain drag plus exact Ctrl+C still work. The shell test drives production xterm and the production context-menu renderer, seeds a clipboard sentinel, delays and counts the modern write, verifies no early toast, checks scratch-textarea cleanup, presses Ctrl+C while the write is still pending, and proves promise settlement preserves a newer selection.

## [1.3.0-alpha.4] - 2026-07-25

This corrective prerelease closes the live terminal copy regression that remained after alpha.3.

### Changed

- **Workbook pane actions are focused on finished workflows.** The incomplete terminal-backed “Switch to view” menu and empty-pane structured views were removed: they duplicated the full Tasks workspace, produced ephemeral blank panes, and introduced hidden-terminal focus and geometry races. Agent work stays in the canonical Tasks experience, while terminal panes retain the dependable session, copy, mirror, move, and lifecycle actions.
- **The alpha.3 visual hierarchy is now the default path throughout the shell.** Workbench, Sessions, Tasks, and the centralized System/Myrlin Dark/Myrlin Light theme registry remain primary; secondary utilities stay behind More and pane-specific menus no longer compete with unfinished embedded views.

### Fixed

- **Ctrl+C now uses Chromium/xterm's trusted native copy event.** A selected shortcut is withheld from the PTY so it cannot become ETX/SIGINT, but Workbook no longer cancels the browser default or depends on permission-gated `navigator.clipboard.writeText`. The exact selection copies on localhost, insecure HTTP origins, and embedded browsers that deny the programmatic Clipboard API; the highlight remains available after copying. Explicit menu and button copies keep the universal Clipboard API plus `execCommand` fallback.
- **Right-click preserves highlighted text through any-motion TUIs.** Workbook blocks the zero-button hover and both right-button edges that Claude Code's `DECSET 1003` mouse mode could consume before `contextmenu`, captures the selection before xterm target handlers run, and binds Copy and Save to Notes to that exact snapshot.
- **Select-mode drag no longer double-focuses or resizes the pane.** The synthetic Shift-mousedown restarts ancestor capture; the app now recognizes an already-active terminal surface and avoids a second focus/activate cycle that could trigger a TUI redraw and erase the selection. Clicking active pane chrome still retains the existing click-anywhere-to-focus behavior.
- **Moved and cached terminals keep the correct host.** Pane swaps and tab-group cache restores now detach and rebind Select controls, capture listeners, touch handlers, resize observation, focus ownership, provider chrome, and xterm owner identity to the destination slot instead of leaving stale controls and cross-pane routing behind.
- **Shared pane slots reject stale asynchronous work.** Deferred mounts, voice punctuation/restarts, image uploads, context-menu actions, fatal errors, provider state, attention/activity markers, and auto-trust updates are fenced to the pane and tab group that initiated them. Closing, moving, caching, or reusing a slot cannot write into or activate its new owner.
- **Mobile terminal and mirror state survives tab-group changes.** The mobile selector is rebuilt from the active group, clears stale active classes, remembers a selected mirror, hides terminal-only controls for mirrors, and restores each mirror’s pinned-to-bottom or manual scroll position after switching away and back.
- **Fresh builds cannot reuse stale copy assets.** Terminal, shell, and mirror scripts carry a new cache token so a browser that previously loaded the broken event path receives this release’s copy and host-ownership code.

### Testing

- The Windows Chromium/xterm acceptance fixture now enables true any-motion mouse reporting (`DECSET 1003`), proves unselected hover reaches the PTY, and proves selected hover plus right-click do not. It verifies trusted native Ctrl+C, exact OS clipboard text, retained selection, zero SIGINT, denied programmatic Clipboard API behavior, explicit menu-copy failure truthfulness, and both secure and genuinely insecure origins.
- Added executable event-order and host-ownership regressions for active versus inactive Select-mode drag, pane swaps, group-cache restoration, and stale-slot event routing, plus mobile mirror-selection and scroll-state coverage.

## [1.3.0-alpha.3] - 2026-07-25

This prerelease consolidates the 1.3 alpha work into a calmer, more dependable Workbook:

- **Focused shell, hierarchy, and density.** Workbench, Sessions, and Tasks are now the primary navigation; Costs, Recent, Project Notes, and System Resources move behind a keyboard-accessible More menu so secondary tools remain available without competing with the active workspace. Empty and preview states are more explicit, dense terminal layouts choose 2x3 or 3x2 from the real canvas width, and attention styling distinguishes active work from passive controls. Appearance now leads with System, Myrlin Dark, and Myrlin Light through a centralized theme registry while preserving all 13 legacy themes, and resource controls use progressive disclosure instead of persistent visual weight. The `?ui=classic` desktop-density fallback remains available.
- **Terminal selection, copy, paste, and TUI reliability.** Ctrl+C with a selection is consumed before it can become SIGINT, including uppercase shortcut keys produced by Caps Lock or Shift. Failed clipboard writes preserve the selection, right-click Copy no longer lets a mouse-reporting TUI erase the selected text, keyboard paste stays on Chromium's trusted native path even when programmatic clipboard reads are denied, insecure-origin fallbacks remain available, and orphan `beforeinput` events cannot drop or duplicate the next paste. Normal versus alternate-buffer scrolling remains covered by the real Chromium/xterm regression matrix.
- **Async ownership and accessible controls.** A failed project activation now rolls back to the last server-confirmed project; stale session, notes, resource, quota, tunnel, PTY, and pinned-note responses cannot overwrite a newer workspace render. Terminal selectors and close actions are sibling semantic buttons with specific accessible names, visible keyboard focus, and 44px coarse-pointer targets.
- **Account and credential reliability.** The provider-neutral Codex account switcher, snapshot deletion, honest token-health states, proactive lineage-aware refresh, write-back theft guard, bounded credential operations, stalled-chain recovery, degraded read mode, and opt-in fail-closed external-pool passive mode make account management recoverable without exposing credential material or allowing competing owners to mutate the same token pool.

### Fixed

- **Copy/paste regression harness isolation (1.3.0-alpha.2).** Windows browser acceptance now snapshots and restores every advertised clipboard format, exchanges one-use startup URLs over parent-owned IPC, shuts down only confirmed owned children, and runs the full SPA with sandboxed profile/state paths plus server-side Git-update and tunnel guards. The ordinary test bootstrap also supplies a process-local random password so importing authentication code cannot read the real home config or rewrite the clone-local ignored config.

- **Copy/paste reliability inside mouse-capturing terminal TUIs (1.3.0-alpha.2).** Right-button mousedown is now withheld from xterm only when a real terminal selection exists, so opening Myrlin's Copy menu cannot let the TUI redraw or destroy that selection first; ordinary right-clicks without a selection retain their prior terminal behavior. The native insecure-origin paste handler now stops same-target listeners after it sends the bracketed payload, preventing xterm from sending the same clipboard text a second time. Selected Ctrl+C still consumes the key before it can become SIGINT, but now clears the selection only after a confirmed clipboard write; if both Clipboard API and `execCommand` fail, the exact selection stays available and the app shows an explicit error instead of silently losing it. A hermetic real-Chromium acceptance fixture exercises checked-in xterm and production terminal/menu code across Windows Shift+drag, Select mode, mouse reporting, Ctrl+C success and denial, right-click Copy, secure keyboard/menu paste, a genuinely insecure HTTP origin, exact-once native paste, and normal-versus-alternate-buffer scrolling. The Windows interaction matrix is covered; macOS force-selection semantics remain a separately documented limitation.

- **Ctrl+C to copy from a terminal pane sent SIGINT to the running CLI on plain-http remote access (user-reported, 2026-07-24).** The Ctrl+C branch of the terminal key handler called the async Clipboard API directly with a chained `.catch()`. On an insecure origin (plain http to a LAN IP or hostname, the README's documented remote-access mode) `navigator.clipboard` is undefined, so the property access threw a SYNCHRONOUS TypeError that `.catch()` could never intercept (it only handles promise rejections, not a throw during property lookup). The exception escaped the handler BEFORE `clearSelection()` and `return false` executed, xterm treated the key as unhandled, and the "copy" keystroke delivered `\x03` (SIGINT) that interrupted the user's running session; the copy itself also silently failed. This is the copy-side twin of paste issue #64, whose fix feature-detected the API on the Ctrl+V branch directly below but was never applied to Ctrl+C. Fixed with a universal helper plus a structural guarantee:
  - **`TerminalPane.copyTextToClipboard(text)`** (terminal.js, shared with app.js through the existing statics seam; terminal.js loads first): feature-detects the writeText FUNCTION (not merely the object) and otherwise copies through a temporary offscreen textarea plus `document.execCommand('copy')`. Unlike programmatic paste, execCommand copy is still permitted from script during a user gesture on every origin, so copy now genuinely WORKS over plain http instead of degrading to a hint. The scratch textarea is always removed in a `finally`, the user's document selection and focus are restored best-effort, a writeText rejection (Safari permission denial) falls back to execCommand, and the helper never throws and its promise never rejects, by contract.
  - **Exception-proof Ctrl+C branch:** the copy and `clearSelection()` calls are bracketed in try/catch with `return false` outside the bracket, so once a selection exists the branch ALWAYS consumes the key; the SIGINT fall-through is structurally impossible even if a future edit breaks the helper's no-throw contract. Plain Ctrl+C with no selection still interrupts as before.
  - **Sweep:** all 14 `writeText` call sites in app.js had the same latent throw-into-the-click-handler flaw (mobile copy button, session ID / resume ID / cwd / selector / session name / project path / encoded name / commit hash / tunnel URL / pairing URL copies, context export markdown) and now route through the helper, most via a new `_copyWithToast` wrapper. Success feedback is unchanged on secure origins and is now honest: sites that previously toasted success unconditionally (even when the call threw) toast an error when the copy actually failed. The service worker registration and every `readText` site were audited and already feature-detect correctly.
  - **Tests:** `test/copy-secure-context-fallback.test.js` now has 21 checks registered in `test/run.js`: source gates on the branch shape, case-normalized shortcuts, the function-level feature detect, the finally cleanup, and a zero-bare-writeText gate over app.js, plus EXECUTED vm proofs that the real extracted branch with `navigator.clipboard` undefined still returns false (key consumed, no SIGINT) while the selection lands on the stub clipboard via the fallback, that uppercase Ctrl+C follows the same safe path, cleanup survives an execCommand throw, and the no-selection fall-through (intentional SIGINT) is preserved. The pre-fix branch was run under the same harness and demonstrably throws before `return false`.

- **Production deadlock: account switcher and usage meter down (credential mutex wedged forever).** The outage: GET /api/credentials stopped answering on the live workbook, so the switcher and header usage meter never rendered again until restart. Root cause in `src/web/credential-manager.js`: the promise-chain mutex (`serialize`) only advances when the running operation's promise settles, and `refreshInactiveToken` contained the one path that could never settle. It cleared its abort timer the moment response HEADERS arrived and only then awaited `res.json()`; when a connection dies without the runtime propagating the failure to the body stream (reproduced on Node v22.16.0: body read pending 306 seconds; in production, hours), that unguarded body read pends forever. Because the refresh runs INSIDE the mutex (usage updates, applies, and the new proactive sweep, which made the wedge recurring and automatic on a 20 minute timer), every later credential operation queued behind it forever. Fixed in four independent layers, each of which alone would have kept the UI alive:
  - **Layer 1, the source fix.** One AbortController now spans the request AND the body read in `refreshInactiveToken`; the timer is cleared only in `finally`, mirroring `fetchUsage` (which was already correct and is now lock-in tested so nobody "optimizes" it into the same bug). An abort during the body read returns a transient `timeout` verdict, never a death or suspect verdict, because our own deadline killing the read says nothing about the token; malformed-but-received JSON still falls through to the status classification unchanged. The same clear-on-headers pattern was found and fixed in `provider-account-manager.js` `_fetchUsage` (the Codex tab's usage fetch runs inside its own mutex and had the identical wedge risk).
  - **Layer 2, per-op deadline.** Every op in `serialize` and `runMacExclusive` (and the generic provider manager's `serialize`) now runs under `withOpDeadline`: past `OP_TIMEOUT_MS` (60s, roughly 4x the worst legitimate apply) or `MAC_OP_TIMEOUT_MS` (120s, SSH round trips) the caller receives a typed, retryable `CRED_OP_TIMEOUT` (HTTP 503) and the chain advances. Timers are unref'd and always cleared; every export site passes a short op label so timeout errors are diagnosable; the refresh-usage batch's per-profile try/catch absorbs the rejection so one wedged profile cannot block the rest (locked by test).
  - **Layer 3, stalled-chain watchdog (on by default).** An unref'd interval (`CHAIN_WATCHDOG_INTERVAL_MS` 30s) records each running op's label and start stamp and force-resets a chain held past `CHAIN_STALL_FACTOR` (3x) times its deadline, logging loudly. With layer 2 it should never fire; it exists so a future deadline bypass cannot resurrect the outage. Cleared in `stopCredentialWatcher` so shutdown and tests never leak it.
  - **Layer 4, route-level degraded mode.** `GET /api/credentials` and the provider list route no longer await their serialized best-effort seed/sync calls unconditionally; those are raced against `LIST_BEST_EFFORT_MS` (2.5s) and the roster (which reads snapshot files directly and never touches the mutex) is served regardless, with `degraded: true` when the pass did not finish. The frontend stores the flag and marks the account chip (title plus `is-degraded` class) instead of showing a blank switcher. `_credApi` in `app.js` also gains a 10s request timeout (`AbortSignal.timeout` with an AbortController fallback) so any future server-side hang degrades into the existing catch paths; a timeout rejects rather than resolving, so it can never be misread as the 404 feature-unavailable signal.
  - **Tests.** New `test/credential-deadlock.test.js` (14, registered in `test/run.js`): a stalled-body HTTP stub (headers plus partial body, never finished) proving `refreshInactiveToken` settles as a transient timeout within deadline plus epsilon (verified to HANG against the pre-fix code), the stalled-401 case, the end-to-end mutex-advance case, the `fetchUsage` lock-in, `CRED_OP_TIMEOUT` for stuck ops with the next queued op still running (both chains), batch tolerance with an abort-ignoring fetch, degraded-mode route responses for both list endpoints, watchdog reset via injected clock, and watchdog disposal.
  - **Out of scope, tracked separately:** the `GET /api/discover` synchronous full-corpus filesystem walk (about 780MB) blocks the event loop and is an independent bug; it is deliberately not addressed by this hardening.

- **"Credentials keep expiring" in the Claude account switcher (honest token states).** Root cause (docs/plans/2026-07-16-credential-expiry-fix-spec.md): refresh tokens are one-time-use; a successful refresh rotates the pair and kills the old refresh token server-side, so any OTHER holder of the same login lineage (a CLI session left running on a switched-away account, a Mac profile, an old claude-swap copy) that refreshes first silently invalidates the workbook's stored copy, and the workbook's next refresh gets `invalid_grant` (or a Cloudflare 403 false positive) and marked the row dead. Four labeling bugs fixed in `src/web/credential-manager.js`:
  - **Verdict split.** Only a definitive `invalid_grant` (HTTP 400/401 with that body) is a one-shot death verdict now. A 403 (usually the Cloudflare WAF, not the OAuth server) and a bodyless 401 are demoted to a new `suspect` verdict that climbs a ladder: the row keeps its prior state and only escalates to `needs_login` on the third CONSECUTIVE suspect (`SUSPECT_ESCALATE_COUNT`). WHY: a single WAF false positive was permanently greying out healthy accounts.
  - **Evidence preserved.** Rejections used to write `lastRefreshError: null`, erasing the at/kind/status story and making every dead row undiagnosable. All rejection paths now record `{ at, kind, status, detail }` (kinds: `auth`, `auth_suspect`, `no_refresh_token`; the detail never contains token material and is never serialized to clients).
  - **Dead-retry window.** A `needs_login` row whose rejection evidence is older than `DEAD_RETRY_MIN` (6h) is retried automatically without force. WHY: a repeat `invalid_grant` is harmless, and the retry self-heals WAF false positives and legacy rows whose evidence the old code nulled.
  - **Amber, not red, while suspect.** An `ok` row under an unresolved suspect ladder maps to `needs-attention` and renders "Temporary auth issue, retrying" instead of flipping straight to the dead state. Dead rows soften to "Signed out here. Run /login as this account once, or press Retry." with a **Retry** button wired to the existing per-profile force route (`POST /api/credentials/refresh-usage`); rows stay unstageable while dead. The rotate-then-persist ordering (persist the rotated pair BEFORE any use) is unchanged everywhere.

### Added

- **Proactive credential refresh (ON by default, lineage-gated).** New `proactiveRefreshMinutes` setting under `settings.credentialSwitcher` (default 20, 0 disables, floor `PROACTIVE_REFRESH_FLOOR_MIN` = 10) drives a guarded `setInterval` in `server.js` that calls the new `proactiveRefreshSweep()`: it rotates ONLY accounts that are not PC-active, not Mac-active (existing lineage hint gate), `tokenState ok`, free of recent `auth_suspect` backoff, and within `PROACTIVE_REFRESH_WINDOW_MIN` (30 min) of access-token lapse; the rotated pair is persisted before any use, then usage refreshes as a freebie. WHY on by default (Arthur's decision, 2026-07-16): rotating just-in-time makes the workbook win the one-time-use refresh-token lineage, which is what keeps parked accounts from "expiring". ACCEPTED RISK, documented in the server WHY comment: winning the lineage can log out a CLI session still running on a switched-away account, and reuse detection can revoke the token family; the gates minimize but do not eliminate this, and /login recovers the account either way.
- **Write-back theft guard.** `_syncActiveTokenToProfileUnlocked` now refuses to adopt live credentials when the live access token equals a DIFFERENT snapshot's stored token: after a switch, a still-running CLI session from the previous account can write its rotated old-account tokens into `~/.claude/.credentials.json`, and adopting them onto the new active account's snapshot would corrupt which snapshot owns which lineage. The guard skips the merge AND the resurrection, logs a benign diagnostic (uuid prefixes only, never token values), and leaves both snapshots intact. The confirming live experiment is deliberately deferred (it would switch the active account mid-work).
- **Tests.** `test/credential-manager.test.js` grows to 55 (verdict split, suspect ladder + reset, evidence preservation, dead-retry due/fresh/legacy, health mapping, sweep gating + persist-before-use + honest failure classification, theft guard + no-false-trip, safe-list leak gate over the new fields); new `test/credential-expiry-ui.test.js` source gate (16 checks: Retry button + copy branches + unstageable dead rows + server interval wiring + accepted-risk comment), registered in `test/run.js`.

- **Delete saved accounts from the switcher.** Every saved-account row in the account panel (Claude rows and the new Codex rows alike) now carries a hover-reveal trash button wired to the snapshot-only delete routes. WHY: saved credentials accumulated forever with no removal path short of hand-deleting files under `~/.myrlin/`. Deleting removes ONLY Myrlin's saved copy; it never logs the account out anywhere, and the confirm modal says exactly that. The button is hidden on the ACTIVE row on purpose: the credential watcher re-captures the live login within about a second, so deleting the active snapshot would be a confusing no-op (switch away first). A 404 from the route (another client already removed it) is treated as success, and a staged selection pointing at the deleted row is cleared. Source gate: `test/credential-delete-ui.test.js`.
- **Codex account switcher (replicates the Claude switcher for ChatGPT Codex).** The account dropdown gains a Claude | Codex tab bar; the Codex tab manages multiple ChatGPT Codex accounts end to end: auto-capture within ~1s of `codex login` (directory watcher on the Codex home filtered to `auth.json`, debounced, with a poll fallback), one-click switching (capture-before-overwrite, timestamped 0600 backups, atomic write, post-apply verification with backup restore on mismatch), rename, delete, and live 5h/week usage meters from the verified `wham/usage` endpoint (epoch-seconds resets converted to exact local times, same bars as Claude rows). Design doc: `docs/plans/2026-07-03-codex-account-switcher-design.md`.
  - **Provider-neutral core.** New `src/web/provider-account-manager.js` and `src/web/provider-account-routes.js` are fully parameterized by a provider-owned capability object (`src/providers/codex/accounts.js`, re-exported as the optional `accounts` member of the Codex provider). WHY: the grep-gate abstraction mandate; zero provider literals outside `src/providers/`, so a future provider is one capability file plus one wiring line. The proven 1698-line Claude credential manager is deliberately NOT migrated onto the generic factory in this build (code preservation); a future phase may re-express it as a capability.
  - **Token policy v1: the workbook NEVER calls an OpenAI token-refresh endpoint.** Switching restores the full stored `auth.json` (refresh token included) and the Codex CLI heals the pair on next launch. Consequence, accepted and surfaced honestly: a parked account whose ~10-day access token aged out shows "usage unavailable" with an `accessExpired` hint until made active once; applying it still works and carries a warning instead of blocking.
  - **Corrected three-state health model, Codex-adapted.** `needs_login` requires DEFINITIVE evidence: a usage 401/403 while the stored access token was NOT yet expired per its JWT exp claim (an expired-token 401 says nothing and the round is skipped entirely). Transient failures (timeout, network, 429, 5xx) only record `lastError` and never kill a row. API-key auth mode is recognized as having no switchable identity (not capturable; explained in the empty state).
  - **Security.** Snapshots and backups live 0600 under the data dir (never in any repo or the npm tarball); routes serialize ONLY the whitelisted safe projection (no `auth`, no tokens, no JWTs; locked by leak-gate tests over responses AND SSE payloads); all six `/api/provider-accounts/:providerId` routes require bearer auth; account ids are validated before any path construction; JWT claims are decode-only untrusted display data, escaped at render.
  - **SSE.** New `provider-accounts:changed` and `provider-accounts:usage` global events with `accountId`/`providerId` payload keys (never a bare `id`, which broadcastSSE would misfile as a workspace id), plus frontend cases so broadcasts can never trigger the default-branch reload storm.
  - **Frontend.** The tab bar branches by `data-kind` (`legacy` renders the existing Claude pipeline byte-for-byte; `provider` renders the generic path), so app.js gains zero provider literals: API URLs are built from the clicked tab's `data-provider-tab`. Codex rows reuse every Claude row class (avatar, plan badge, usage bars, ACTIVE pill, staged radio, pencil, trash). Mac strip, header chip, and header meter stay Claude-only in v1. A 404 from an old server marks the Codex tab unavailable instead of erroring.
  - **Tests.** `test/codex-accounts-capability.test.js` (19), `test/provider-account-manager.test.js` (29, hermetic with synthetic JWTs and a local usage stub), `test/provider-account-routes.test.js` (11), `test/provider-account-tabs.test.js` (16), all registered in `test/run.js`.

- **External credential pool passive mode (opt-in, fail-closed).** When Myrlin's bridge credential router owns the Claude snapshot pool, CWM can now be switched into a passive, strictly read-only role so two processes never fight over one-time-use refresh-token lineages. Ownership is an explicit opt-in (injected `externalBridgeOwner` manager option, strict `CWM_CRED_EXTERNAL_BRIDGE_OWNER=1` env flag, or the persisted `settings.credentialSwitcher.externalBridgeOwner` flag); the bridge's `.myrlin-credential-pool-owner.json` marker in the pool root is validated and surfaced as sanitized diagnostics (owner, pid, startedAt; never the lease id) but its presence alone NEVER enables the mode, and once configured the mode stays fail-closed even when the marker is absent or malformed. In passive mode:
  - Every credential mutation boundary (`saveSnapshot`, capture, label, delete, apply, live-file backup, snapshot write, OAuth token refresh) throws a typed HTTP 409 `CRED_POOL_EXTERNAL_OWNER` conflict naming the owner, and every mutating credential route returns it before touching the manager; `GET /api/credentials` becomes a true read (no seed sentinel, no snapshot import, no live-token sync-back rides a list request).
  - The rotation write-back watcher, the PC live-token sync, the Mac sync-back merge, the claude-swap seed, and (new in this merge, since the sweep postdates the passive branch) the proactive refresh sweep are all no-ops, and usage reads serve the last safely cached projection with zero token-endpoint or usage-endpoint calls.
  - `mac-bridge` install/apply are blocked before any ssh/scp process spawns (defense in depth for non-route callers), mapped to the same conflict code.
  - Merge reconciliation with the 2026-07-24 deadlock hardening: the stalled-chain watchdog still arms in passive mode (passive reads ride the same serialized chain), the passive list path never queues on the mutex so it is served directly and never marked degraded, and passive mode introduces no network call or unbounded await inside the mutex (all its guards are synchronous, bounded marker-file reads or top-of-function throws).
  - **Tests.** Fail-closed manager coverage (marker-alone stays writable, env/settings opt-in, byte-identical snapshot and live files across every blocked path), route coverage (typed 409 on all seven mutating routes, passive GET leaves bytes untouched and emits no SSE), and mac-bridge coverage (no process spawned, no sync-back, no hint mutation) in `test/credential-manager.test.js`, `test/credential-routes.test.js`, and `test/mac-bridge.test.js`.

## [1.2.0] - 2026-07-03

First stable release of the 1.2 line, consolidating 1.2.0-alpha.0 through 1.2.0-alpha.16. It supersedes 0.9.36 as the default (`@latest`) install. The detailed, root-cause-level per-alpha entries are retained below this section on purpose (they carry the WHY for every change); the list here is a curated rollup.

### Added

- **Multi-provider support.** A provider abstraction layer with first-class Claude Code and ChatGPT Codex providers (session discovery, search, transcript parsing, spawn/resume), so the workbench manages both CLIs side by side under one UI.
- **Account switcher.** Manage multiple Claude accounts: snapshot each account's credentials, swap the active one, and see per-account usage and token state.
- **Per-model usage meter.** Top-right Opus / Fable / session bars with exact local reset times, plus per-account usage rows in the switcher dropdown.
- **Mac credential sync.** Choose which account lives on the PC, the Mac, or both, with a live Mac-state probe and a token-lineage safety guard that stops PC usage-polling from silently logging the Mac out.
- **Read-only live session mirror (Tier 1).** Watch any discovered session's conversation stream live in a pane without resuming or touching it, plus a green liveness dot on sessions whose transcript was written in the last two minutes.
- **Short-TTL git-conflict status cache** for the workspace conflict endpoint.

### Changed

- **Session model reorganized around the provider registry**; discovery, search, and cost tracking now flow through per-provider modules rather than Claude-only code paths.
- **Tightened the npm publish allow-list (`files`)** so only product source ships; excluded a stale `src/web/public/.backup` asset directory from the tarball.

### Fixed

- **Notification storm on tab switch** (edge-triggered re-arm, replay suppression, refire cooldown, focus ack) so already-viewed panes stop re-dinging.
- **Terminal text corruption and mobile-size leak on shared PTYs** (size ownership, no-op resize suppression, reset-before-replay) so a desktop pane is no longer scrunched after a phone views it.
- **Windows console-window flashing:** a complete `windowsHide` sweep across every server-side child process (git, ssh/scp, cloudflared, resource probes, self-update, browser-open, the restart template).
- **Paste on insecure LAN origins** (bracketed-paste isolation plus a secure-context clipboard fallback).
- **Smooth terminal scrolling** (issue #41).
- **Mobile UX:** scrollable tab bar and a selectable account bottom sheet.
- **Search performance:** async, byte-tail reads with mtime ordering, eliminating multi-second hangs on large transcript corpora.

### Security

- Credential snapshots are stored `0600` under the gitignored data dir; token values are never serialized to browser clients (whitelisted projections only) and never passed in argv over SSH (secrets travel as `0600` temp files).
- Removed an operator credential-extraction script from the published tarball via the `files` allow-list.

## [1.2.0-alpha.16] - 2026-07-03

### Added

- **Read-only live session mirror (issue #10, Tier 1).** Right-click any discovered session in the sidebar and pick "Mirror Session" to watch its conversation stream live in a terminal-grid pane, without resuming or otherwise touching the session. Why: sessions started outside the workbook (another window, SSH, the Mac) were invisible until they finished; the only option was resuming them, which grabs the session lock and can derail the CLI driving it. The mirror tails the provider's transcript artifact (Claude project JSONL, Codex rollout JSONL) by byte offset, so a 1.86GB transcript costs a 2MB tail read, never a full scan.
  - **Backend (`src/web/mirror-service.js`)**: refcounted watcher registry keyed by `provider:providerSessionId`; one `JsonlTailer` per key no matter how many tabs watch it. Named limits: 2MB history window, 10 concurrent watchers (409 past that), 60s idle grace after the last close (a page refresh keeps the warm watcher), 8192-char message text cap (SSE frames stay small), and a sweep that unsubscribes devices whose SSE client vanished so a killed tab can never pin a watcher forever. Truncated/rotated transcripts broadcast `mirror:reset` and re-seed from the new tail; a deleted transcript broadcasts `mirror:closed` and tears down.
  - **API**: `POST /api/mirror/open` (returns history + byte offsets + a live flag), `POST /api/mirror/close`, `GET /api/mirror/history` (stateless "Load earlier" paging window). All auth-gated; provider ids validated with the same pattern as session creation, session ids as `[a-zA-Z0-9_-]{1,256}`.
  - **SSE scoping**: `mirror:*` events are delivered ONLY to the SSE clients whose `deviceId` opened that mirror, never globally. Why: a busy session emits bursts of transcript lines and broadcasting them to every connected client would melt mobile connections; scoping also keeps one tab's mirror from echoing into another.
  - **Frontend (`src/web/public/mirror-view.js`)**: new `mirror` pane view type. Provider-accented header with a live dot, user bubbles / assistant blocks / collapsed tool rows, pinned-bottom autoscroll that never yanks a user out of scrollback, Load-earlier with scroll anchoring, skeleton loading rows, and every transcript string escaped (tool output inside transcripts is treated as hostile HTML). Each browser tab carries a per-tab `deviceId` (sessionStorage) appended to the SSE URL and mirror calls; SSE reconnects idempotently re-open active mirrors so no lines are lost across a drop. Mirror panes persist in the pane layout and re-open on restore and tab-group switches.
  - **Duplicate-free sequencing**: history snapshots and live batches tile by byte offset (`prevOffset`/`offset` on every batch, tailer drained before each history snapshot); the client skips already-covered batches and falls back to one idempotent re-open on a detected gap.
- **Live dot on discovered sessions (issue #10, Phase 0).** Sidebar session rows show a green pulse when the session's transcript was written within the last 2 minutes (`live` + `lastActiveMs` fields on `/api/discover` records, threshold `CWM_LIVE_THRESHOLD_MS`). The tooltip states this is an mtime heuristic ("transcript recently written"), not proof a process is running, so a hung CLI is not misrepresented. Archived threads are never marked live. The dot's pulse is disabled under `prefers-reduced-motion`.
- **Short-TTL git status cache for the workspace conflict endpoint (src/web/git-status-cache.js).** GET /api/workspaces/:id/conflicts previously spawned one `git status --porcelain` per running session on every poll (60s timer plus manual refreshes). Results are now cached per resolved repo path for GIT_CONFLICT_CACHE_TTL_MS (15s), concurrent callers share the in-flight spawn, and any mutating git command routed through gitExec (commit, checkout, merge, ...) eagerly invalidates its path so post-mutation polls are never stale. Git run outside gitExec (e.g. typed in a terminal pane) is covered by the TTL alone; that tradeoff is documented in the module. Failures are cached for the TTL on purpose so non-repo workingDirs do not re-spawn git every poll.

### Fixed

- **Complete windowsHide sweep: no server-side child process can flash a console window on Windows.** Every child_process call site in the server-side code now passes `windowsHide: true`. WHY: with a windowless parent (daemonized supervisor, watchdog-spawned workbook) any spawn without the flag pops a visible conhost/OpenConsole window; earlier fixes covered gitExec and the git panel/conflict pollers, this sweep covers everything else. Swept sites: the browser-open helpers (src/gui.js), cloudflared quick/token tunnel spawns, tasklist/wmic/pgrep/lsof/powershell/ps resource probes, the gh CLI runner, claude --print one-shots (task extraction, PR description), where/which availability probes, npm install and git fetch/rev-list/log in the self-update path, worktree/spinoff init_script hooks, the git rev-parse worktree guard, spinoff branch info (rev-list/diff), the generated state/_restart.js script plus the spawn inside it, the td CLI adapter (src/core/td-adapter.js), the supervisor daemon spawn, PID probe, and GUI child (src/supervisor.js), and the legacy session launcher wrapper (src/core/session-manager.js, where the visible session window is created by start in its own console, so only the helper flash is removed). Interactive node-pty sessions (pty.spawn in src/web/pty-manager.js) are deliberately untouched: those ConPTY terminals are the panes the user opens on purpose.

### Testing

- New hermetic suites (sandboxed `CWM_DATA_DIR`, tmpdir JSONL fixtures, fake registry providers, fast injected timings; every watcher disposed in `finally` so `npm test` can never hang on `fs.watch` handles): `test/mirror-service.test.js` (open/close refcounts, batched broadcasts with contiguous offsets, watcher limit, truncate reset, gap-free `readEarlier` paging, text cap, vanished-subscriber sweep, disposeAll) and `test/mirror-routes.test.js` (route happy paths, 400/404/409 error mapping, input validation, auth gate, SSE `deviceId` scoping proof, and the Phase 0 `groupProviderSessionsForUI` live-flag matrix: fresh/stale/archived/missing mtimes).
- `test/run.js` now also registers the Tier 1 foundation suites that shipped standalone (`jsonl-tailer`, `claude-mirror-parse`, `codex-mirror-parse`), so the byte-offset tailer and both provider `parseLine` contracts run in CI with everything else.
- New `test/windows-hide-sweep.test.js`: source-scan gate asserting every child_process call site in the swept server-side files (all of src/ except the browser bundle src/web/public, plus runtime scripts watchdog.js, restart-workbook.js, recover-orphan-panes.js) carries windowsHide in its options, with a pattern-rot floor; method-style pty.spawn stays out of scope by design.
- New `test/git-conflict-cache.test.js`: hermetic TTL/hit/expiry/eager-invalidation coverage for the conflict status cache (injected clock, counting stub, zero real git spawns).

### Notes

- Tier 2 (fork a mirrored session into an interactive one via the provider's resume/fork capability; `supportsForkResume` is already exported by both providers) and Tier 3 (multi-client presence badges showing who else is mirroring) are deliberately deferred follow-ups; the read-only pane ships first.

## [1.2.0-alpha.15] - 2026-07-03

### Added

- **Per-machine account apply: choose which account lives on the PC, the Mac, or both.** The account panel's rows now carry PC / MAC location segments (filled = active there, outline = installed on the Mac but not active, dimmed = absent, dotted = unknown because no sweep has run or the Mac is unreachable). Clicking a segment stages that account for THAT machine independently; the footer lists the pending `PC:` / `Mac:` lines and Save applies each machine on its own with per-machine toasts. The old "Also apply on Mac Mini" checkbox is removed and its `cwm_credMirrorMac` localStorage key is retired (cleared on load), because a single mirror flag could only ever push the same account to both machines. `POST /api/credentials/apply` gains an ADDITIVE body shape `{pc?: profileId, mac?: profileId}` next to the unchanged legacy `{profileId, mirrorToMac?}` (old clients keep working byte for byte); the response gains `machines: {pc, mac}` with per-machine outcomes, and a Mac failure NEVER rolls back a successful PC apply (the PC transaction runs first and commits regardless). The bridge's `mirrorToMac` is factored into `installProfileOnMac` (scp + mkdir + atomic mv + chmod 600, no activation) and `applyProfileOnMac` (install + `claude-profile use` + active-marker/`cmp -s` verification with the 45s floor), with `mirrorToMac` kept as a back-compat alias. Before activating, `applyProfileOnMac` runs one inventory sweep and syncs the CURRENT Mac-active account's freshest tokens back (strictly-newer merge), so switching the Mac away from an account never strands its last rotation; an unknown Mac-side profile is never clobbered silently, it is flagged in a warning (the Mac-side tool preserves it as a profile). A verified Mac apply updates the mac-state cache optimistically and broadcasts `credentials:mac`, so every client's strip and segments repaint without a second SSH round trip. Nothing moves until the Mac bridge is configured (host `alloy`) AND enabled in the gear modal. Mobile parity: the same segments, pending lines, and toasts work in the account bottom sheet with enlarged touch targets.
- **Mac-active lineage guard (CRITICAL token-safety fix).** New persisted hint `settings.credentialSwitcher.macActiveProfileId` (manager `setMacActiveHint`/`getMacActiveHint`, written through a new injected `settingsPatcher` so it survives restarts) records which account is live on the Mac; a successful `applyProfileOnMac` sets it and every inventory sweep corrects it from observed reality. The usage poller now has a lineage gate in `_updateSnapshotUsageUnlocked`: the Mac-active account NEVER goes through `refreshInactiveToken` on the PC. WHY this is critical: the OAuth server revokes the old refresh token the moment a new one is issued, so the PC's background usage polling (which refreshes any expired inactive account roughly every 12h) would steal the refresh-token lineage from the Mac and silently log the Mac out within a day; this is exactly the failure that made cross-machine credential sharing flaky. Usage for the Mac-active account is fetched strictly read-only with the stored access token; when that token is expired, the manager first pulls fresh Mac state (one inventory sweep + strictly-newer sync-back, registered by the routes layer as a callback to avoid a circular require) and uses the ADOPTED token; if the Mac is offline the round is simply skipped, with zero token-endpoint calls, and the account is never marked dead. Proven by a counting stub on the token endpoint: a Mac-active expired account triggers ZERO token-endpoint calls, while the identical shape without the hint refreshes once (contrast case).
- **Mac state visibility in the account switcher (machines strip + live probe).** The panel now answers "which account lives where" instead of blind-pushing. A new `readMacInventory` in the Mac bridge reads the Mac's active profile marker, installed profile list, live token file, and (lagging) identity in ONE ssh round trip with unique section separators, degrading section by section on garbled output; exit 255 or a timeout maps to `reachable:false` because an offline Mac is a state, not an error. `resolveInventoryProfiles` matches remote profile names to local snapshots by the same slug rule the mirror uses. The manager gained `syncBackFromMac` (adopts the Mac's rotated tokens into the matching snapshot ONLY when the incoming `expiresAt` is strictly newer, mirroring the PC rotation write-back rule, and resurrects `tokenState` to ok because a live Mac login is definitive positive evidence) plus a whitelisted in-memory mac-state cache (`getMacState`/`setMacState`; the whitelist means no secret-bearing field can ever ride into anything a route serializes). Two new routes: `GET /api/credentials/mac-state` serves the cache and NEVER triggers SSH (`stale` flags a cache older than 5 minutes); `POST /api/credentials/mac-state/refresh` performs one sweep, syncs the matched Mac-active account's tokens back, updates the cache, and broadcasts the sanitized result as the new `credentials:mac` SSE event (registered in `GLOBAL_EVENT_TYPES`). The frontend renders a machines strip (`#account-machines`: PC pill with the active account, Mac pill with the matched name / offline / checking / unknown), hidden while the bridge is disabled; the panel refresh button now also fires one live Mac probe in parallel, and opening the panel auto-probes only when the cache is older than 5 minutes. Why: the Mac (`alloy`, offline half the day) must be observable before anything moves to it, and its own token rotations must flow back so a Mac-rotated account never looks dead on the PC. Requires the Mac bridge to be configured (host `alloy`) AND enabled in the gear modal first; until then nothing probes and nothing renders.
- **Concurrency: SSH work never blocks credential operations.** Mac bridge calls ride a dedicated `_macChain` mutex (`runMacExclusive`) in the manager so two SSH conversations can never interleave, while the snapshot mutex is taken only for the short local read/merge portions. Why: holding the snapshot mutex across a multi-second SSH round trip would freeze every list/apply/rename behind the network.
- **Mac sync settings modal (gear in the account panel header).** The Mac mirror config (enable toggle, host, user, profile tool path, post-swap command) was previously reachable only via raw API calls, so retargeting the bridge after the Mac was renamed (`arthurs-mac-mini` is dead; the machine is now `alloy` / 100.111.181.106) required code or curl. A gear button (`#account-mac-config-btn`) now opens a modal bound to the existing `GET`/`PUT /api/credentials/mac-config` routes. Why: nothing credential-related may ever move to the Mac until the host is set and the feature is explicitly enabled here; this modal is that switch. Host and user stay charset-validated server-side (ssh option-injection guard).

### Fixed

- **SSH to a renamed or first-seen Mac host no longer hard-fails under BatchMode.** `ssh`/`scp` in the Mac bridge ran with `BatchMode=yes` (correct: a server must never sit on an interactive prompt) but without a host-key policy, so a host not yet in `known_hosts` (exactly what a rename to `alloy` produces) failed every connection forever with no way to accept the key. Both argv builders now pass `-o StrictHostKeyChecking=accept-new`: trust-on-first-use on the private tailnet, while a CHANGED key for a known host still fails loudly (the actual man-in-the-middle signal). Deliberately never `=no`, which would also accept changed keys.

### Testing

- New hermetic `test/mac-bridge.test.js`: every ssh/scp child process is replaced via the new `opts.execFileImpl` injection point, so zero real processes spawn. Locks the argv shape (accept-new present, `=no` absent, BatchMode, ConnectTimeout cap at 10s), exit-code mapping (255 = unreachable, 127 = tool missing, verify mismatch), and the load-bearing security property that token values and token key names never appear in any argv while the secret payload travels only inside the 0600 scp temp file that is deleted afterwards.
- Mac-state coverage: `test/mac-bridge.test.js` locks the one-round-trip inventory parser (section splitting, garbled/missing sections, unreachable mapping, validation-before-spawn) and the slug matcher; `test/credential-manager.test.js` locks the strictly-newer `syncBackFromMac` merge rule and the `setMacState` field whitelist against hostile input; `test/credential-routes.test.js` exercises the mac-state routes against a fake in-process bridge (the real server stays `CWM_CRED_DISABLE_MAC=1` for the whole suite) and asserts the Mac live token text and every token key name are absent from route responses and the `credentials:mac` SSE payload.
- Per-machine apply coverage: the bridge tests lock the install/apply split (install never activates and never sweeps; apply runs the pre-use sync-back, warns on an unmatched or unreachable Mac, and records the lineage hint only after a VERIFIED apply); the routes tests lock the `{pc, mac}` body shape (independent applies, Mac failure never rolls back the PC swap on disk, Mac-only leaves the PC files byte-identical, legacy `{profileId, mirrorToMac}` behavior preserved including the alreadyActive mirror skip); the manager tests lock hint persistence across a manager restart and the LINEAGE GATE PROOF (zero token-endpoint calls for a Mac-active expired account, with a no-hint contrast case that refreshes once).

## [1.2.0-alpha.14] - 2026-07-03

### Added

- **Per-model usage meter in the header top-right.** A compact stack of thin bars for the ACTIVE account: a Session (5h) bar showing the true account-wide cooldown, plus Opus and Fable bars sourced from their per-model limits, each with utilization percent and the EXACT local reset time (e.g. "Resets Tue 7:00 AM"). Why: the account chip only surfaced the 5-hour countdown; per-model headroom (especially Fable) was invisible, so the only way to know whether a model was about to rate-limit was to hit the wall. Honesty note baked into the UI copy: the Anthropic usage endpoint exposes per-model data only as WEEKLY-scoped limits (there is no per-model hourly window), so the Opus/Fable bars are labelled as weekly in their tooltips and are never presented as hourly; the 5h Session bar is the real short-window cooldown. Fill colors follow the existing design 6.3 thresholds (green below 60, amber 60 to 85, red above 85) via semantic Catppuccin tokens so all 13 themes render correctly; bars animate width over 200ms and honor `prefers-reduced-motion`. The meter renders on the same path as the account chip (initial load, refresh-usage, account switch, both credentials SSE broadcasts) and hides entirely when there is no active account or no usage data (no spinners). A width ladder sheds the inline reset text below 1600px (tooltips and the panel keep it) and the whole widget below 1280px to protect the tab row.
- **Opus and Fable rows in the account switcher panel.** Each account row now lists per-model weekly usage under the existing 5h and week mini-bars, with the exact local reset time (absolute, not a countdown, because the window is weekly). Sourced from the same model-scoped limits with a fallback to the endpoint's top-level `seven_day_opus`/`seven_day_sonnet` windows when present.
- **Mobile parity via the account bottom sheet.** The header-right rail is hidden on phones, so the same Session/Opus/Fable bars render at the top of the account bottom sheet (`#account-panel-meter`), with a one-line scope note ("5h is the session window. Opus and Fable are weekly limits.") because touch has no hover tooltips to carry that nuance. Desktop hides the sheet mirror (the header widget plus per-row usage lines already cover it).

### Fixed

- **Per-model usage data no longer dropped by the usage mapper.** `_mapUsageResponse` in `credential-manager.js` only kept `limits[].scope` when it was a string, but the live endpoint sends the per-model breakdown as `weekly_scoped` limit rows whose scope is an OBJECT (`scope.model.display_name` = "Opus" / "Fable" / "Sonnet"), so the model dimension never reached the stored snapshot or the UI. The mapper now extracts `scope.model.display_name` onto a whitelisted `row.model` field (the raw scope object is never stored), keeps string scopes as before, and additionally captures the top-level `seven_day_opus`/`seven_day_sonnet` windows when the endpoint populates them. Malformed scopes degrade to no model field, never a crash. This mapper fix is what unblocks every meter surface above.

## [1.2.0-alpha.13] - 2026-07-02

### Fixed

- **Mobile account switcher sheet is no longer greyed out and unselectable.** On a phone, tapping the top-left account chip opened the bottom sheet but the whole sheet appeared dimmed and no row could be tapped. Root cause: on mobile `.app` is `position: fixed`, and a fixed-position element ALWAYS forms a stacking context, so the account panel (which lives inside the header inside `.app`) was trapped inside `.app`. The dim backdrop was appended to `document.body`, a sibling of `.app`, at `z-index: 10000`; because `.app` sits at effective `z-index: auto` in the root, the backdrop painted over the entire `.app` subtree including the panel, and the `body.account-sheet-open .app-header { z-index: 10001 }` lift could not help because that lift only reorders things WITHIN `.app`. A hit-test at a row centre confirmed every tap was landing on the backdrop, not the row. The fix mounts the backdrop INSIDE `.account-switcher` (the panel's own parent) so the backdrop and panel share the header's stacking context, where `panel z-index 10001 > backdrop z-index 10000` is a direct, robust comparison that no longer depends on `.app`'s stacking behaviour. A desktop base rule forces the backdrop to `display: none` so the switcher-nested element stays inert on desktop (the mobile media query still shows it as a full-viewport dim at phone widths). Verified across a 390px mobile viewport (rows hittable, tap stages a healthy row and enables Save, backdrop-tap and Cancel close the sheet) and a 1280px desktop viewport (dropdown still anchored under the chip, no backdrop, rows clickable), so desktop behaviour is unchanged.
- **The 60-second conflict check no longer bursts a terminal window per running session.** `checkForConflicts` runs every 60s and, when the active workspace had 2 or more running sessions, called `GET /api/workspaces/:id/conflicts`, which runs `git status --porcelain` for EVERY running session concurrently. On Windows (with Windows Terminal as the default console host) each spawn flashes an OpenConsole/conhost window, so a workspace with 8 running sessions popped 8 terminal windows every minute and churned the CPU. An event-based process trace caught the exact burst: 8 `git status --porcelain` from the workbook plus 8 `OpenConsole.exe` inside one 60ms window. The git-based scan is now gated behind the conflict center being open (it runs on demand when you open the center or click refresh there, both of which set the flag before calling), so the background 60s poll no longer spawns any git; it relies on the JSONL-based conflict check, which spawns nothing. Reload to apply; no server restart needed.
- **Git panels no longer flash terminals and churn processes every 10 seconds.** The Tasks git tab and any docked `tasks-git` pane auto-refreshed by calling `git status` on a 10s `setInterval`, and neither timer paused when the browser tab was hidden. On Windows each `git status` spawns a `git.exe` plus a `conhost.exe`, so a parked git panel produced a steady terminal-flash and constant process creation that lagged the machine (a 90s process trace caught 8 `git status --porcelain` plus 12 conhosts, all from the workbook, and nothing else). Both timers now skip entirely while `document.hidden` (a background tab polls not at all) and share a single, less aggressive cadence (`GIT_PANEL_POLL_MS`, 30s, up from 10s), cutting the foreground spawn rate by 3x and the background rate to zero. Reload the page to pick it up; no server restart is needed. A server-side git-status cache to coalesce overlapping polls is deferred to the next coordinated restart.
- **Watchdog no longer spawns duplicate workbook instances under load** (`scripts/watchdog.js`, local ops script, not shipped in the npm package). The watchdog declared the workbook dead on a single failed HTTP HEAD probe (4s timeout), but a healthy workbook whose event loop is briefly blocked (heavy search, a git status/fetch sweep across many workspaces, or general machine load) simply misses that one probe. Each false-death spawned a replacement `gui.js` that could not bind port 3457 (the real one still held it) and lingered as an inert zombie, so a busy afternoon accumulated several duplicate node processes and multiplied the per-instance git/cmd churn, lagging the machine. The tick loop now requires `FAILS_BEFORE_SPAWN` (3) consecutive missed probes before it suspects death, and adds a final raw TCP `isPortBound()` gate: because the OS kernel completes the TCP handshake for a listening socket even when the owning process has a blocked event loop, a successful connect proves the workbook is alive but busy, so the watchdog resets and keeps polling instead of spawning. A replacement is spawned only after 3 consecutive misses AND the port is confirmed free. Verified by relaunching the patched watchdog against a healthy live workbook and confirming zero replacement spawns across multiple poll cycles with exactly one `gui.js` and one watchdog remaining.

## [1.2.0-alpha.12] - 2026-07-02

### Added

- **Claude account switcher (top-left header dropdown).** A new account chip in the top left lists every saved Claude credential with its 5-hour and weekly usage plus reset countdowns, lets you stage a selection, and commits it with a Save button that makes that account the machine-wide login. Selecting is staged; Save opens a confirm and then, on success, offers to restart running sessions so they pick up the new login (reusing the existing `restartAllSessions` flow, which now takes an additive `{ skipConfirm }` option to avoid a double prompt). New terminals use the new account immediately; already-running Claude processes keep their previous account until restarted. Credentials are nameable with editable labels, and unnamed credentials are still listed (display falls back to the email, then to a short account id), so you can tag each account and see who it belongs to at a glance. Optional Mac Mini mirror (config-gated, off by default) pushes the selected account to the Mac via the existing `claude-profile` tooling so the bridge that burns the Max subscription follows the swap. Mobile renders the panel as a full-width bottom sheet with a drag handle, backdrop, safe-area padding, and always-visible rename affordance; the header chip collapses to avatar-only on narrow screens. A credential is a PAIR (the token file `~/.claude/.credentials.json` plus the `oauthAccount` identity in `~/.claude.json`); apply writes both, identity first and token file last, atomically, with backups, rollback on failure, and a post-write verify.
- **Token rotation write-back keeps saved accounts alive.** OAuth access tokens rotate every few hours (the CLI refreshes and rewrites the credentials file). A server-side watcher (`fs.watch` on the credentials directory, debounced, with a 30s mtime poll fallback and a self-write guard during apply) detects each rotation, matches it to the owning account by `accountUuid`, and writes the fresh token back into that account's snapshot, so a saved credential does not silently go stale between sessions. This is the mechanism the old standalone tool lacked.
- **Robust workbook auto-restart script** (`scripts/restart-workbook.js`). Kills only the port-owner PID (never a blanket process kill), coordinates with the port-polling watchdog to bring the service back on 3457, waits for `/api/health`, then verifies and repairs the Cloudflare tunnel ingress to `http://127.0.0.1:3457` and confirms the connector via the Cloudflare API (treating the Cloudflare Access 302 as edge-healthy). Reaps duplicate instances and asserts a single listener. Includes `--check` and `--dry-run` preview modes and distinct exit codes per failure stage.

### Fixed

- **The one-time claude-swap roster import actually runs on machines with an active login.** The seed guard used "store already has snapshots" as its already-imported signal, but the rotation watcher's initial sync self-captures the active account at boot before any HTTP request can trigger the seed, so on every real machine the guard saw a non-empty store and skipped the import forever; the account dropdown then only ever showed the active account. The count-based guard also meant deleting every account would silently re-import stale profiles later. Seeding is now gated by an explicit one-time sentinel file (`<accountsDir>/.seeded`, written after the first import attempt completes, even when zero profiles import) instead of snapshot count, and `startServer` queues the seed before starting the watcher so the first boot imports the roster and the watcher's self-capture is additive. Deleting an account can never resurrect it via the seed. Regression-tested against the exact boot ordering (self-capture first, then seed).
- **Header account chip no longer collides with the view-tab row at laptop widths.** The chip (up to ~290px with the usage countdown) painted over the tab strip at 1280px because the switcher could not shrink and `.header-left` had its overflow unhidden for the dropdown. The measured budget (tabs ~640px plus the right action rail ~347px) leaves only ~261px at 1280 and ~110px at 1024, so the header now sheds the least valuable pixels first: the chip clips instead of spilling, the meta countdown hides below 1460px, the title yields to a logo-only brand below 1360px (the account label is the more valuable pixel there), and below 1180px the chip collapses to avatar-only, the same treatment the mobile sheet already used under 480px. Verified overlap-free at 1024, 1280, and 1440 with Playwright geometry checks.
- **ACTIVE row reset countdowns no longer clip in the account panel.** The row grid reserved the side column (ACTIVE pill plus rename pencil) for the full row height, so the active row's usage lines lost ~70px and "Resets in 1 hr 59 min" truncated while inactive rows showed it whole. The row body now flattens into the row grid (`display: contents`) with the usage and note lines spanning to the row edge below the primary line; the side controls span only the first two rows, which also keeps the 44px touch pencil from inflating the first line on mobile.
- **Corrected the false "token expired / needs re-login" logic inherited from the standalone swap tool.** The prior tool marked an account dead whenever a token refresh returned nothing, but its refresh helper returned the same nothing for every failure kind (network error, timeout, HTTP 429, HTTP 5xx, offline, as well as real auth rejection), so a transient blip permanently greyed out a perfectly healthy account. The account switcher replaces the blunt `tokenDead` boolean with a three-state model (`ok` / `unverified` / `needs_login`): an expired access token is never treated as death (it is normal and self-heals via refresh and never blocks apply), and `needs_login` is set only on a definitive auth rejection (`invalid_grant`, or an empty stored refresh token with an expired access token), never on transient failures or a usage-endpoint error. Accounts seeded from the old tool import as `unverified` (their stale dead flags ignored) and re-verify themselves on first use, and the rotation watcher resurrects the currently-active account to `ok` automatically. The refresh request uses a 15s timeout (not 5s) and classifies outcomes by HTTP status and body rather than by an exception.

### Security

- **Claude OAuth tokens never reach the browser.** Every credential API response and SSE payload is a whitelisted safe projection (identity/label/plan/usage/health only); access and refresh tokens stay server-side and are never logged. Apply takes an account id, not token material. Snapshot and backup files are written with 0600 (best effort) under the gitignored data dir, and `state/claude-accounts/` is added to `.gitignore` belt-and-suspenders. SSH host/user for the optional Mac mirror are charset-validated (no option injection) and secrets travel only as scp'd temp files, never on remote command lines.

## [1.2.0-alpha.11] - 2026-07-02

### Added

- **Smooth terminal scrolling (issue #41).** Mouse wheel and Shift+PageUp/PageDown scrolling in terminal panes previously jumped in instant discrete row blocks. The bundled xterm.js 6.0.0 already supports animated scrolling via its `smoothScrollDuration` option; panes now construct with a 120ms animation (`SMOOTH_SCROLL_DURATION_MS` in terminal.js) and a new "Smooth Scrolling" toggle in Settings, Terminal category (default on, persisted in `cwm_settings`) applies live to every open pane via `applySmoothScrollSetting()`, including panes cached for inactive tab groups. The duration resolves through `TerminalPane.getSmoothScrollDuration()`, which returns 0 (instant) when the toggle is off or the OS requests reduced motion; an OS-level `prefers-reduced-motion` change re-applies live through a media-query listener (with the deprecated `addListener` fallback for older Safari). The custom mobile touch momentum engine is unaffected: its rAF physics already interpolate per frame, and a per-call ease on top would double-animate, so `onTouchStart` sets an `_engineDriving` flag and zeroes the duration for the gesture, and every gesture-end path (momentum decay via `stopMomentum`, no-momentum lift, long-press selection) restores the configured duration fresh from the getter.

### Fixed

- **Paste silently did nothing for every non-localhost user (issue #64).** Regression chain: PR #45 (commit cee137a) added an unconditional `e.preventDefault()` to the Ctrl+V/Cmd+V branch of `TerminalPane.attachCustomKeyEventHandler` to stop a double-paste on localhost. That cancels the browser's native paste, leaving `pasteFromClipboard()` (`navigator.clipboard.readText()`) as the only paste path. `navigator.clipboard` only exists in secure contexts (https or localhost), so on insecure origins (http over LAN, the documented remote-access mode) it is undefined; the rejection was caught and logged to console only, and paste did nothing on every browser and device. The native fallback handlers (`beforeinput` insertFromPaste and the `paste` listener, deduped via `_pasteHandled`) still worked but never fired because the keydown `preventDefault` cancelled the native paste that would have triggered them. The custom context-menu Paste and the mobile long-press sheet both funneled into the same dead `pasteFromClipboard()`, and the native context menu is suppressed over terminals, so no paste path worked on http. Fix: the Ctrl+V branch now feature-detects `navigator.clipboard.readText`; in a secure context it keeps `preventDefault` + `pasteFromClipboard()` (preserving the PR #45 double-paste fix), and in an insecure context it skips `preventDefault` so the browser's native paste flows through the existing `beforeinput`/`paste` handlers and is sent exactly once. `pasteFromClipboard()` now guards clipboard availability up front (returns `false` instead of throwing into the catch), and both the unavailable-API and denied-read (Safari) paths surface a user-visible toast via a bubbling `cwm:paste-unavailable` CustomEvent handled in `app.js`, telling the user that Ctrl+V (Cmd+V on Mac) still works. The context-menu Paste item now feature-detects the API too: when unavailable it shows that toast, focuses the pane so the shortcut lands, and relabels itself "Paste (Ctrl+V)" instead of a fire-and-forget call that does nothing.

### Security

- **Explicit npm `files` allow-list so only the runtime ships.** `package.json` had no `files` field, so `npm publish` shipped almost everything not gitignored, including local operator scripts that never belong in a public package (a Chrome/Edge DPAPI credential-extraction helper, state seeders, recovery and watchdog scripts, and build tooling). The package now declares `files: [src/, scripts/postinstall.js, README.md, LICENSE, CHANGELOG.md, DEMO_GUIDE.md]`, dropping the tarball from 91 to 86 files with zero dev scripts. Note: none of those scripts reached the registry (all predated the last publish or postdated it), so this is preventative packaging hygiene, not a leak remediation. Same class of packaging drift that previously caused issues #27, #32, #33, and #39; the allow-list is the durable fix.

## [1.2.0-alpha.10] - 2026-07-02

### Fixed

- **Terminal output corrupting mid-session (repeated/mixed text in scrollback).** Three compounding causes, all rooted in one PTY being shared by N WebSocket clients with raw byte broadcast. (1) Every client resize was applied last-writer-wins, and ConPTY repaints the whole viewport on EVERY resize; those repaint bytes are indistinguishable from real output, so they were appended to the shared scrollback and streamed to clients whose terminals had different dimensions. Resizes now go through a central `applyViewport` gate on `PtySession` that suppresses no-op resizes, and the client (`safeFit`/`_sendResizeIfChanged`) only sends a resize when its cols/rows actually changed. (2) The backpressure valve silently dropped chunks for clients whose WS buffer exceeded 64KB; incremental TUI redraws then landed on stale screen state with no recovery. Lagged clients are now flagged and, once their buffer drains, receive a `{type:'reset'}` control message plus a full scrollback replay instead of a permanent gap. (3) Reconnect replay could duplicate the replay tail because the client had no authoritative "clear now" signal; the server now sends `{type:'reset'}` before every scrollback replay (attach and lag-resync), and the client resets its terminal and drops buffered partial writes on receipt. Additionally, a `ResizeObserver` leak in tab-group switching let a cached (detached) pane fit itself against a slot container now hosting a different session and send stale dims to its PTY; `safeFit` now bails when the pane's terminal element is not connected to the document.
- **Desktop terminal stuck in "mobile mode" after viewing the session on a phone.** The PTY had no notion of which device's geometry should win, so the last resize from ANY client (including a phone attaching in the background or its keyboard opening/closing) reshaped the terminal for everyone. `PtySession` now tracks `cols`/`rows` and a `sizeOwner`: typing (`input`) or the new `activate` message claims geometry ownership for that client; a bare `resize` from a non-owner is stored on the connection but not applied. When the owner disconnects, the most recently active remaining client becomes owner and its stored viewport is restored. A sole client attaching to a live session applies its own dimensions before the scrollback replay so history renders at viewing size. The frontend sends `activate` (ownership claim + refit, no stdin writes) when a pane is clicked, when the browser tab becomes visible, on window focus, and after tab-group restore, so returning to the PC re-asserts desktop geometry automatically. Both directions of a mixed-version window degrade gracefully: old servers parse and ignore `activate`; new clients never depend on receiving `reset`.

- **Cost badges broke for every session when a Codex session was tracked** (production 500). `GET /api/cost/batch` dispatches `provider.findArtifactPath(resumeSessionId)` for each store session, but `codexProvider` exported neither `findArtifactPath` nor `findArtifactByWorkingDir`, so a single codex-tagged session threw `provider.findArtifactPath is not a function` and 500'd the whole batch, Claude sessions included. Both methods now exist on the Codex provider with the exact claude-parity shape (synchronous, absolute-path-or-null; `findArtifactByWorkingDir` returns `{jsonlPath, claudeSessionId}` where the legacy key name is the cross-provider contract server.js reads). The misleading JSDoc in `claude/index.js` that claimed this parity already existed is corrected.
- **Global search results were dead clicks.** The results click handler called `this.openConversationResult(...)`, which was never defined anywhere. The method now exists: it finds an empty terminal pane and resumes the conversation with the provider-correct CLI (Codex results resume via `codex`, not the default), reading the provider from the result element's `data-provider` (already rendered by SRCH-05).
- **AI find-session "Open" spawned broken resumes.** For store sessions, `_openFindResult` passed the Myrlin store UUID as `resumeSessionId`, making the CLI fail with "No conversation found with session ID"; the store spawn path resolves the real transcript UUID server-side, so the client no longer passes one. Both branches also resolved the CLI with `getProviderCliBinary(null)` (always the default provider); they now use the result's provider, which the server includes in find-session matches.
- **Sidebar workspace drops silently converted Codex sessions to Claude.** The `cwm/project-session` and `cwm/project` drop branches hardcoded `command: 'claude'` while forwarding `provider: psProvider`; both now resolve the CLI via `getProviderCliBinary(<provider>)`, removing the hardcoded literal entirely.
- **Dragging a terminal pane into a sidebar workspace/folder never worked.** Pane headers only advertised `cwm/terminal-swap`, a type no sidebar drop target accepts. The pane-header dragstart now ALSO sets `cwm/session` (store-managed panes, so `moveSessionToWorkspace` works unchanged) or a `cwm/project-session` JSON payload (ad-hoc panes, matching the exact `{sessionName, projectPath, displayName, provider}` shape the drop branch parses). Pane-to-pane swap is unaffected because the pane drop handler checks `cwm/terminal-swap` first.

- **Notification storm: "ready for input" toasts and dings fired on every tab switch and output burst**, even for panes the user had already viewed. Four compounding root causes, each now fixed:
  - *Level-triggered idle detection* (`terminal.js`). Any output byte (Ink border repaint, focus-report echo, SIGWINCH redraw, spinner tick, scrollback replay) reset the once-per-cycle `_idleNotified` guard, so every cosmetic repaint followed by 2s of quiet re-fired the notification. Re-arm is now edge-triggered: the flushed chunk is ANSI-stripped and must contain at least `MIN_REARM_CHARS` (24) visible characters to count as new work. The 2s debounced idle check still runs on every flush.
  - *Scrollback replay notified on mount, reconnect, and tab switch* (`terminal.js`). The server replays up to 100KB of buffer on attach; that replay flowed through the detector and made every prompt-parked pane toast ~2s after a page load or group switch. `ws.onopen` now arms a `REPLAY_SUPPRESS_MS` (3s) window during which `_checkForCompletion` disarms and stays silent. A per-pane `IDLE_REFIRE_COOLDOWN_MS` (30s) at the dispatch site additionally caps how often a single pane can fire `terminal-idle`.
  - *No acknowledgement on focus + stale active-slot suppression* (`app.js`). Clicking or viewing a pane never consumed its pending needs-attention state, and `switchTerminalGroup` never updated `_activeTerminalSlot`, so the "don't notify the active pane" comparison used the previous group's slot index. `setActiveTerminalPane` now acknowledges on focus (refreshes the per-session dedupe entry, marks the pane's idle cycle notified, clears the amber "Needs input" badge), `switchTerminalGroup` re-points `_activeTerminalSlot` at the restored group's first filled slot, and `onTerminalIdle` gained a per-session dedupe (`SESSION_NOTIFY_DEDUPE_MS`, 60s, reset by genuine new activity) plus suppression of toast+sound for panes visible in the active group while the window has focus (passive indicators, border flash, tab dot, title flash, still run where applicable).
  - *Unthrottled chime that leaked AudioContexts* (`app.js`). `_playNotificationSound` created a new `AudioContext` per ding and never closed it; browsers cap concurrent contexts, so a storm eventually broke tab audio. It now has a global `CHIME_COOLDOWN_MS` (5s) and reuses one lazily-created context (with a `resume()` for autoplay-policy suspensions).
- **Amber "Needs input" badge never rendered.** The `terminal-needs-input` listener looked up `terminal-pane-${i}` but pane elements are id'd `term-pane-${i}`, so the badge dataset flag was set on a null element. Fixed the selector; the badge now appears when auto-trust declines to answer a prompt and is cleared when the user focuses the pane.
- **Workspace tab bar is now touch-scrollable** (P0-1). `.terminal-group-tab` carried `touch-action: none` (a DragDropTouch accommodation), and since the tabs fill the strip, a finger dragging across them could never pan the strip's `overflow-x: auto`. Tabs, the strip, and folder headers now use `touch-action: pan-x`; press-hold drag-to-reorder still works because a stationary 350ms hold never starts a native pan. The strip also preserves `scrollLeft` across `renderTerminalGroupTabs()` innerHTML re-renders and scrolls the active tab into view after every render and tab switch (desktop benefits too; it previously snapped to the start on every switch).
- **Terminal tab group right-click menu never opened.** The tab `contextmenu` handler passed an items array to `showContextMenu(sessionId, x, y)`, whose session lookup always failed, so the menu silently no-oped. Tab items now build through a shared `_buildTerminalTabContextItems()` and route through `_renderContextItems` (floating menu on desktop, action sheet on mobile).
- **Phantom design tokens defined (broken hover/border states repaired).** Five custom properties were consumed across styles.css and styles-mobile.css but never defined, so every rule using them silently did nothing: `--bg-hover` (context-menu and discover-row hover, meaning NO hover highlight rendered on any context menu in the app), `--border` (context-menu/submenu/discover borders and separators), `--surface-1`/`--surface-2` (settings nav-rail hover/active surfaces, Codex status chips, provider pill, workspace-group stripe fallbacks), and `--text-base` (nav-rail and Codex chip text). Each is now a `:root` alias of the closest existing Catppuccin token (`--surface0`, `--border-default`, `--surface0`, `--surface1`, `--text`), chosen to match what visually-similar working components already use. Aliases reference palette vars, so all 13 themes cascade automatically with zero per-theme overrides. Also fixed a phantom `var(--mono)` (real token is `--font-mono`) on the raw-docs textarea.
- **Contradictory radius fallbacks removed.** `var(--radius-sm, 4px)` disagreed with the real 6px token, and `var(--radius-xs, 3px)` referenced a token that did not exist. `--radius-xs: 4px` is now defined at `:root` (completing the 4/6/10/14/18 scale) and all five fallback sites reference the tokens plainly.
- **Unstyled dialog containers styled.** `.modal-panel` (New Task, Spinoff), `.modal-dialog` (Create PR), and the global search `.qs-overlay`/`.qs-panel`/`.qs-input` had zero stylesheet rules; they rendered with no card surface over the blurred backdrop. They now share the exact `.modal`/`.modal-overlay`/`.quick-switcher` recipes (surface, border, radius, shadow, entry animation); inline per-dialog `max-width`/`max-height` overrides still apply, and the `hidden`-attribute display toggling used by app.js is preserved.
- **Hardcoded Mocha palette leaks removed (theme correctness).** `.btn-primary:hover` used literal `#d4b4fa`; now `color-mix(in srgb, var(--mauve) 85%, white)` so all 13 themes get a correct primary hover. The sidebar `colorMap` and the prompt-modal color swatches emitted hardcoded hexes; both now emit `var(--name)` tokens (matching the existing tag-badge pattern), so workspace stripes, group chips, and picker swatches re-resolve on theme switch. The Cloudflare named-tunnel row dropped its dead `var(--btn-bg,#313244)`-style fallbacks and raw `#89b4fa`/`#1e1e2e` buttons for `--surface0`/`--border-subtle`/`--blue`/`--base`. terminal.js error divs ("xterm not loaded", "init failed") use `var(--red)` instead of `#f38ba8`. The xterm ANSI palettes in terminal.js stay hardcoded by design: xterm.js cannot consume CSS var() values, and `getCurrentTheme()` already swaps concrete palettes per theme.
- **Native alert() replaced with a design-system modal for the task timeline.** "View Timeline" on a kanban card now opens a themed info modal with a monospace, scrollable body via the new `showInfoModal()` (single dismiss button, same cleanup path as `showChoiceModal`, no listener leaks) instead of dumping rows into `alert()`. The crash-recovery fallback UI keeps its native `alert()`/`confirm()` intentionally: it only runs when the app failed to construct and the modal DOM has been replaced wholesale, so no modal API exists on that path (documented inline).
- **Em dashes and mixed ellipsis removed from user-visible copy.** Toasts ("Codex settings updated...", "Moved N sessions...", "Session refocused..."), the td Binary Path setting description, and the icon-picker Material category tag now use commas, semicolons, or single hyphens. Literal ellipsis characters normalized to ASCII `...` in the Cloudflare tunnel copy and td loading states.
- **Long-press gesture collisions** (P1-2). The pane's 600ms context long-press no longer fires when the touch lands on the xterm surface on mobile (terminal.js arms text selection at 400ms on the same hold; the pane menu stays reachable from the pane header and tab strip). The workspace, session, and discovered-project lists clear their 500ms long-press timers on `dragstart` so DragDropTouch drags (armed at 350ms) no longer pop a context sheet mid-drag.
- **Global search ignored its time budget on large corpora (observed 78s for a 5s budget).** Both provider search adapters read every transcript with `fs.readFileSync`; on a real corpus (5,696 JSONLs, 4.6GB, largest file 1.86GB) each sync read blocks the event loop, so neither the in-loop budget check nor the dispatcher's hard-timeout race timer could fire between reads, and files over V8's ~512MB string limit threw and were silently unsearchable. Reads are now asynchronous with an explicit yield between files; files above 8MB get a 2MB tail-window read (JSONL is append-only, so the tail is the most recent content, and previously-unsearchable giant files now contribute matches); and the Claude file list is sorted most-recently-modified first so a budget cutoff spends its time on the sessions most likely to matter. Note: for tail-window matches, `lineNumber` is relative to the window.

### Added

- **Archived Codex sessions are discoverable and searchable.** `$CODEX_HOME/archived_sessions/` holds ended threads in the same rollout JSONL format but was invisible to discovery and content search. Codex `discover()` now scans it (guarded by `existsSync`, live `sessions/` entry wins on id collision, works even when only `archived_sessions/` exists) tagging results `archived: true`; codex search includes archived rollouts and tags their results; the discovered-projects sidebar shows a muted `archived` pill on those rows. Why: no tracked session is ever lost, including threads Codex has archived.
- **Server-side session title overrides: renames are now searchable and cross-device.** New store slot `providerSessionTitles` (`{[providerId]: {[uuid]: title}}`, mirroring the `providerSessionSettings` pattern) with `get/setProviderSessionTitle` (empty title is the explicit delete path). New `PUT /api/session-titles/:providerId/:uuid` route (provider id validated against the registry, uuid via `sanitizeSessionId`, 200-char cap). Read-time merges apply the override in `groupProviderSessionsForUI` (sidebar + `/api/discover` + find-session metadata) and on `GET /api/search` results keyed by `(provider, sessionId)`. The search dispatcher also emits synthetic `Matched by name` results for store session names/topics and title overrides that match the query, so custom names find their sessions even when the transcript text does not match. `syncSessionTitle` in the frontend keeps localStorage as an offline cache and fire-and-forgets the PUT, resolving the provider from linked sessions or open panes (never a hardcoded literal; skips the write when unresolvable).
- **Mobile More sheet exposes everything the hidden header had** (P0-2/P0-3). `.header-right` is display:none on phones, which orphaned Settings, themes, pairing, the session manager, and the conflict indicator; Tasks/Recent/Resources had no bottom-bar tab. The More sheet now includes: Tasks, Recent, Resources (via `setViewMode`), Settings, Theme (submenu built from the existing theme dropdown, check on the active theme), Pair Device, Sessions (session manager), and Conflicts with a live count (only when nonzero). All entries reuse the exact functions the header buttons call.
- **Settings panel is a full-screen sheet on phones** (P1-1). The 520px popover with a 152px nav rail left ~210px of content at 390px width. On mobile the panel is now 100dvh edge-to-edge and the category rail becomes a horizontal, scrollable chip strip above the body.
- **Tab group touch management** (P1-3). Delegated 500ms long-press on the tab strip opens the same context items as desktop right-click as an action sheet. Rename routes to the prompt modal on touch (inline editing of an 80px field under a virtual keyboard is unusable). The close x is visible at 0.5 opacity on mobile and tabs get a 40px min-height touch target. The long-press timer clears on `dragstart` since tabs are draggable.
- **"Move to Tab..." in the terminal pane context menu** (P1-4). Submenu of all other tab groups calling the existing `moveTerminalToGroup`. Previously drag-only, which had no touch path; works on desktop and mobile.
- **Tab strip polish** (P2). Trailing-edge fade mask plus `scroll-snap-type: x proximity` on the strip (snap-align on tabs) scoped to mobile; a `matchMedia('(max-width: 768px)')` change listener rebuilds both tab strips when crossing the breakpoint (rotation/resize); the mobile terminal-tab close button gets a 12px-inset invisible hit-area extension.

### Tests

- Added `test/pty-resize-ownership.test.js` (7): reset-marker-before-replay ordering, sole-attach viewport apply before replay, no-op resize suppression, ownership transfer on input, `activate` claiming ownership without stdin writes plus unknown-type tolerance, viewport restore on owner disconnect, and lagged-client reset+resync without duplicated chunks.
- Added `test/idle-notification-gating.test.js` (19 checks): behavioral sandbox tests for the edge-triggered re-arm, replay-suppression window, refire cooldown, and once-per-cycle dispatch in `terminal.js`, plus source-presence gates for the `app.js` half (dedupe map, focus acknowledgement, active-slot re-point, chime cooldown, shared AudioContext).
- **`test/search-dispatch.test.js` made hermetic.** Three of its tests left the real provider enabled, so `/api/search` scanned the machine's actual transcript corpus; on a multi-GB corpus the synchronous reads block the event loop (the hard-timeout race timer never fires) and the whole suite hangs indefinitely. Those tests now disable the real provider around their requests (restored in `finally`), exercising the dispatch path with stubs only.
- **Regression gate `test/mobile-ux-fixes.test.js`**: 18 string-match checks over styles.css, styles-mobile.css, and app.js locking every fix above (no-jsdom source-harvest pattern, registered in test/run.js).
- Added `test/phantom-tokens.test.js` (8 checks): regression gate asserting every `var(--x)` consumed in styles.css/styles-mobile.css is defined in the stylesheets (with an audited allow-list for tokens set inline from app.js, such as `--ws-color` and `--vh`), that the five repaired aliases stay var()-based (never hex), and that the contradictory radius fallbacks stay dead. Registered in test/run.js.

## [1.2.0-alpha.9] - 2026-05-11

### Added

- **Settings page left-side category rail.** Sticky nav inside the Settings panel listing every category from the registry plus an explicit "Providers" entry. Click any item to smooth-scroll to that section; a scroll-spy keeps the active item highlighted as you scroll naturally. Plays with all 13 Catppuccin themes via existing tokens (`--mauve` accent, `--surface-1` hover). Builds automatically from `settingsRegistry`; async Providers section joins the rail after it renders.

### Changed

- **Autostart Scheduled Task pins `PORT=3457`** (matching the current Cloudflared tunnel mapping) via a small `scripts/autostart-wrapper.cmd` shim emitted by `setup-autostart.ps1`. Without this pin, a reboot would default the workbook to `:3456` and silently break `workbook.myrlin.dev`. The wrapper is gitignored (user-specific paths).

## [1.2.0-alpha.8] - 2026-05-11

### Added

- **Codex bottom status strip on every Codex pane** (Plan 22-01). 26px chip row absolutely positioned along the bottom edge of `data-provider="codex"` panes showing `model Â· sandbox Â· approval Â· effort Â· [BYPASS]? Â· [features N]?`. Each chip is clickable â€” opens the matching submenu from `_buildCodexPaneMenu` anchored to the chip rect. Bypass chip only renders when bypass is ON (red, `letter-spacing` 0.08em, impossible to miss). `/api/discover` now returns `adHocProviderSettings` so the strip hydrates immediately for discovered Codex Desktop sessions without a Myrlin store record.
- **Auto-discovery for Codex sessions** (Plan 22-03). New `fs.watch` on `$CODEX_HOME/sessions` with 500ms debounce + 5-minute fallback poll. The provider's `init({onChange})` wires through the registry; server invalidates `_discoverCache` and broadcasts SSE `discover:refreshed`. Frontend re-fetches `/api/discover` on the event. New Codex CLI / Codex Desktop sessions appear in the sidebar within ~1 second of being created. Subagent filter from alpha.1 still in effect.
- **`scripts/setup-cloudflared.ps1`** â€” idempotent installer/refresher for the `workbook.myrlin.dev` tunnel config. Reads the current `~/.cloudflared/config.yml`, patches the workbook hostname's upstream port (currently 3457 on this PC, was 3456), validates ingress, and prompts for a service restart.
- **`scripts/setup-power-never-sleep.ps1`** â€” applies "never sleep / never turn off display" on AC and disables hibernate so the tunnel stays reachable.
- **`docs/OPERATIONS.md`** â€” runbook for the three auto-restart layers, Cloudflare assets, log locations, Service Token rotation, port-mismatch recovery, and failure scenarios.

## [1.2.0-alpha.7] - 2026-05-11

### Fixed

- **Ad-hoc pane right-click menu was nearly empty.** `_buildSessionContextItems` bailed with `return null` when the upstream session id was not in the Myrlin store, erasing the entire shared block (Start/Stop, Model, Naming, Tags, Insights, etc.) from the right-click menu on Codex Desktop panes opened via "Open in Terminal" (Plan 22-04). New `_buildAdHocSessionContextItems` factory returns the universal subset that works without a store record: Naming (Rename Pane + Auto Title), Insights (Summarize + Copy ID + Copy Path), and "Add to <active workspace>" adoption.
- **"Session doesn't exist" when starting Bypass on an adopted Codex session.** `POST /api/sessions` silently dropped the `provider` field from the request body, so adopted Codex sessions persisted as untagged â†’ defaulted to Claude via the read-side normalizer â†’ `Start (Bypass)` launched `claude --dangerously-skip-permissions` against a Codex UUID. Now the route validates and forwards `provider`. `launchSession` also got provider-aware: Claude uses `--dangerously-skip-permissions`, Codex uses `--dangerously-bypass-approvals-and-sandbox`.
- **Settings search hid the Providers section when typing "provider".** The static settings registry has no entries containing the word; the renderer early-returned with "No matching settings" before the async `_renderProvidersSection` could run. Now the filter-empty path still kicks the async section.

### Changed

- **Stronger provider differentiation** (Plan 22-02). Pane tint 4% â†’ 8%, top accent 3px â†’ 4px, tint tokens 6% â†’ 10%. New `.pane-provider-pill` in every pane header (green dot + "Codex" / mauve dot + "Claude"). Sidebar `.ws-session-item`, `.project-session-item`, and `.project-accordion` all carry a 3px provider stripe. Theme-safe via `--provider-{id}-accent`.
- **Visible workspace group membership** (Plan 22-05). Each grouped workspace row shows a 4px left-edge stripe in the group's color and a `.ws-group-chip` with the group name; hovering the chip reveals a Ã— button that calls `removeWorkspaceFromGroup`. Click handler intercepts the Ã— before row activation.

### Tests

- Added `test/adhoc-pane-menu.test.js` (8), `test/provider-label-pill.test.js` (10), `test/workspace-group-ux.test.js` (9). Updated `test/css-tokens.test.js` to accept any tint percentage in [1..99] (the Pitfall 7 guard still enforces var()-only references).

### Deferred to alpha.8

- Codex pane bottom status strip with 6 clickable chips (Plan 22-01).
- Auto-discovery via `fs.watch` + 5-min fallback poll (Plan 22-03).
- Cloudflared tunnel + always-on workbook.myrlin.dev (brainstorm pending).

## [1.2.0-alpha.6] - 2026-05-11

### Fixed

- **Codex settings menu items 404'd on right-click-opened Codex Desktop panes.** Enabling bypass (or changing any of the 6 menu items) on a Codex pane that was opened via right-click "Open in Terminal" returned "Session not found." The PUT `/api/sessions/:id/provider-settings` endpoint required a Myrlin store record, but discovered Codex Desktop sessions use the upstream Codex UUID directly as the pane id and never get a store record until the user adds them to a workspace. Architectural root cause: the alpha.4 settings persistence model only addressed managed sessions, not ad-hoc panes.

### Changed

- **New state slot `providerSessionSettings`** stores per-(provider, upstreamSessionId) settings bundles for ad-hoc sessions. `pty-manager` looks up this slot when no store record exists for the pane, so settings persist across pane restarts even for never-saved Codex Desktop sessions.
- **PUT route now accepts `provider` in the body** as a fallback when the URL `:id` is not in `store.sessions`. Provider id is validated against `^[a-z][a-z0-9_-]{0,32}$` and the upstream session id against the existing shell-safe regex. Same per-key enum validation runs in both paths.
- **Diagnostic spawn log line.** `pty-manager` now logs `[PTY] spawn provider=... sessionId=... resumeSessionId=... providerSettings=...` once per spawn so `logs/server.log` shows what flags entered the descriptor when a CLI-level "session not found" is reported. Settings keys are enum/short so no sensitive data leaks.

### Tests

- Added 5 new ad-hoc cases to `test/codex-settings-route.test.js` (13 total): 200 on ad-hoc PUT with `body.provider`, 404 on ad-hoc PUT without `body.provider`, 404 on malformed provider id, 400 on enum violation in ad-hoc path, 400 on shell-unsafe url :id.

## [1.2.0-alpha.5] - 2026-05-11

### Fixed

- **"Session id cannot be found" when right-clicking a Codex Desktop session and choosing Open in Terminal.** `showProjectSessionContextMenu` hardcoded the Claude CLI binary for its Open in Terminal action and its Add to Project POST. Right-clicking any Codex (or future-provider) session in Discovered Projects sent `claude resume <codex-uuid>` to the PTY, and Claude rightly refused because the UUID lives in `~/.codex/sessions/`, not `~/.claude/projects/`. The contextmenu dispatcher now forwards `sessionItem.dataset.provider` and the menu factory resolves the CLI via `getProviderCliBinary(provider)`. Drag-drop already did the right thing (Plan 19-02 closed that loop); this closes the right-click loop too. Reported by Arthur. Added regression test `test/project-session-resume-provider.test.js`.

### Added

- **True boot-time auto-start (Windows).** `scripts/setup-autostart.ps1` now registers `Myrlin-Workbook` as a Scheduled Task with `AtStartup` trigger + S4U logon, so the workbook starts the moment the machine boots â€” no user login needed. Three-strike Task Scheduler restart-on-failure policy covers the rare case where the supervisor itself dies. To install: `powershell -ExecutionPolicy Bypass -File scripts/setup-autostart.ps1`. Cleans up the legacy `CWM-GUI-AutoStart` task on upgrade.
- **Supervisor never gives up (default).** `CWM_MAX_RESTARTS` default raised from `20` to `Infinity` so an unattended autostart session never throws up its hands. Set `CWM_MAX_RESTARTS=20` for debug runs that want to fail loud. Added exponential back-off after 5 consecutive fast-fails (capped at 60s) so a wedged port or bad config doesn't burn CPU.

## [1.2.0-alpha.4] - 2026-05-11

### Added

- **Right-click "Codex settings" submenu on Codex panes.** Surfaces all six per-session knobs in one menu: model (gpt-5-codex / gpt-5 / o3), sandbox (read-only / workspace-write / danger-full-access), approval policy (untrusted / on-failure / on-request / never), reasoning effort (minimal / low / medium / high), bypass toggle, and features (web_search, view_image, plan_tool, apply_patch_tool). Claude panes are unaffected â€” the menu dispatches on `data-provider`.
- **Per-session provider settings persistence.** New `state.sessions[id].providerSettings.codex` bundle persists each Codex session's knobs. New store helpers `updateSessionProviderSettings()` and `getSessionProviderSettings()` keep the surface narrow.
- **New API: `PUT /api/sessions/:id/provider-settings`.** Validates against per-key enum allow-lists, rejects shell-unsafe values via the same `SHELL_UNSAFE` regex used elsewhere in `server.js`, persists through `store.updateSessionProviderSettings()`. Returns 404 on unknown session id, 400 on validation failure, 401 without auth.
- **Spawn wiring.** `codexProvider.spawnCommand` now consumes an optional `providerSettings` field and emits the canonical Codex CLI argv: `-m <model>`, `-s <sandbox>`, `-a <approvalPolicy>`, `-c model_reasoning_effort="<effort>"`, `--dangerously-bypass-approvals-and-sandbox`, `--enable <feature>` pairs. Unknown values are dropped with a `console.warn` (no throw). Positional `resume <id>` stays last so flag-shaped session ids cannot be misparsed. `pty-manager` reads the per-session bundle from the store on every spawn so settings changes take effect on the next pane restart.
- **Bypass confirmation modal.** Enabling the `--dangerously-bypass-approvals-and-sandbox` flag routes through `showConfirmModal` with a red action button. Turning the flag OFF is a single click (no confirmation needed; weakening the sandbox is dangerous, restoring it is not).

### Tests

- Added `test/codex-settings-route.test.js` (8 tests) â€” happy-path triple, bypass toggle, features array, unknown key 400, enum-violating value 400, shell-unsafe value 400, unknown session 404, missing auth 401.
- Added `test/pane-context-menu.test.js` (9 tests) â€” string-match gate asserting `_buildCodexPaneMenu` exists, dispatches by `dataset.provider`, includes all 6 designed items, and routes bypass through `showConfirmModal`.
- Extended `test/codex-spawn.test.js` with 9 new tests covering each providerSettings â†’ CLI flag translation, drop-unknown semantics, and the `resume <id>` last-position invariant.

## [1.2.0-alpha.3] - 2026-05-11

### Changed

- **Codex panes now visually distinct.** Bumped per-provider pane styling from a 1px top accent + 24px fade to a 3px top accent + 2px bottom accent + 64px tint fade + ~4% saturation whole-pane background derived from each provider's Catppuccin token. Claude panes get a mauve treatment, Codex get green; works across all 13 themes via `color-mix()`. The xterm canvas still paints opaque over its own area so text contrast is unaffected (Pitfall F still satisfied). Updated `test/css-tokens.test.js` Pitfall F guard to allow any 16-128px tint cutoff instead of pinning to 24px exactly.

### Planned (deferred to v1.2.0-alpha.4)

- Right-click "Codex settings" submenu on Codex panes surfacing model, sandbox, approval policy, reasoning effort, bypass toggle, and feature flags. Plan written to `.planning/phases/21-codex-pane-customization/21-01-PLAN.md`.

## [1.2.0-alpha.2] - 2026-05-11

### Fixed

- **ChatGPT tab in Discovered Projects showed 0 even with Codex sessions on disk.** `groupProviderSessionsForUI()` built project accordion buckets without a `provider` field on the bucket itself (only the inner session records carried `provider`). The frontend's `renderProjects` filter at `app.js` reads `p.provider` on the bucket with a `|| claude-id` fallback, so every non-Claude bucket was misidentified as Claude and filtered out when the ChatGPT tab was selected. Fixed by setting `bucket.provider = provider.id` in the server helper. Frontend `_mergeProjectsByProvider` now also stamps the provider id from the outer response key as a defense-in-depth fallback for older servers or future providers that bypass the helper. Added regression test in `test/discover-route.test.js`. Reported by Arthur.

## [1.2.0-alpha.1] - 2026-05-11

### Fixed

- **Codex discovery showed subagent threads as conversations.** Codex Desktop spawns explorer-role subagents (Pascal, Linnaeus, Copernicus, etc.) from a parent user thread; each subagent gets its own rollout file with `payload.source.subagent.thread_spawn` set. The discover module was treating these as user conversations and surfacing them in the sidebar, inflating the list (e.g., 34 entries for a user with only 5 actual conversations). Now filtered at session_meta read time in both the fast-path and walk-fallback. Subagent rollouts remain on disk and remain parseable when a parent thread's transcript references them. Added regression test `test/codex-discover.test.js` Test 9. Reported by Arthur.

## [1.2.0-alpha.0] - 2026-05-11

> **Alpha release.** First publishable cut of v1.2 Multi-Provider Chat Discovery. Ships under the `alpha` npm dist-tag; install with `npm i myrlin-workbook@alpha`. Existing users on `latest` (v0.9.36) are unaffected. Production-ready stable v1.2 follows after dogfooding.

### Added

- **Multi-provider session support.** Myrlin now manages sessions from multiple AI coding CLIs through a clean `Provider` abstraction at `src/providers/`. Ships Claude Code (existing) + ChatGPT Codex (new). Gemini and others drop in via the same interface in v1.3.
- **ChatGPT Codex provider.** Discovers Codex sessions from `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (default `~/.codex`), parses the RolloutLine envelope schema (`session_meta`, `turn_context`, `event_msg`, `response_item`, `compacted`), supports pre-0.45 bare-JSON fallback, runs `codex resume <id>` as a full PTY pane. Off by default; enable via Settings â†’ Providers.
- **Sidebar provider tabs.** New tab strip in the sidebar header filters discovered sessions by provider (All / Claude / ChatGPT). Tab state persists in localStorage; switching preserves scroll position; badges show per-provider session counts and update live via SSE.
- **Per-provider visual identity.** Each session item, project accordion, and terminal pane carries a `data-provider` attribute. CSS tokens `--provider-claude-accent` (mauve), `--provider-codex-accent` (green), `--provider-gemini-accent` (blue, reserved) cascade through all 13 themes automatically via the existing Catppuccin palette.
- **Settings â†’ Providers section.** One tile per registered provider with toggle switch, accent swatch, and CLI availability check. Disabling a provider with running PTYs shows a confirmation modal warning that sessions will continue but cannot be restarted.
- **Per-provider PTY behaviors.** Idle detection, Shift+Enter key bindings, and bracketed paste are all dispatched per-pane based on the active session's provider. No cross-contamination between Claude and Codex panes.
- **API additions (additive only, no breaking changes):**
  - `GET /api/providers` â€” returns `[{id, displayName, accentToken, enabled, available, supportsCost, cliBinary}]`
  - `PUT /api/providers/:id/enabled` â€” toggles a provider; calls `provider.init()` or `provider.dispose()` with 5s timeouts
  - `GET /api/discover` â€” now returns `{projects: {claude: [...], codex: [...]}}` keyed by provider id; `?legacy=1` retains v1.1 array shape for one release
  - `GET /api/search` â€” `Promise.allSettled` dispatcher across enabled providers; each result carries `provider` field; response includes `partial: true` + `timedOutProviders: [...]` on timeout
  - All `GET /api/sessions` and `GET /api/workspaces/:id` records now carry a `provider` field (defaults to `'claude'` for backward compat)
- **State migration v1 â†’ v2.** Schema bump with layered defense: explicit `migrateStateV1toV2()` + read-side defensive `provider: 'claude'` default. `_migrateBackupFiles()` runs unconditionally on init. Idempotent on re-launch; refuses to start with clear error on corrupt fixture.
- **Cost tracking discipline.** `Provider.supportsCost()` is mandatory in the interface. Codex sessions show `â€”` with "Cost not tracked for this provider" tooltip â€” never $0.00. Aggregate cost totals exclude unsupported providers and disclose "(Claude only)" on aggregates. Real cost tracking for non-Claude providers will follow in v1.3.
- **Grep gate (CI).** `test/grep-gate.test.js` enforces zero `'claude'` or `'codex'` string literals outside `src/providers/`. Legitimate exceptions carry `// gsd:provider-literal-allowed` markers. Prevents the abstraction from rotting as future providers are added.
- **Drag-drop preserves provider.** Dragging a session across workspaces preserves its provider tag in the receiving `/api/sessions` request.

### Changed

- **Internal refactor.** Existing Claude code (~600 LOC) relocated from `src/web/server.js` into `src/providers/claude/{index,discover,parse,path-decode,spawn,search}.js`. No user-facing behavior change.
- **pty-manager pass-through mode.** Provider returns a `SpawnDescriptor`; pty-manager owns `node-pty.spawn`. Non-default-command spawns (scheduler/td/templates) bypass the provider lookup entirely.
- **Search per-provider.** Each provider now implements `search({query, limit, timeBudgetMs})`. The server endpoint dispatches via `Promise.allSettled`. Claude-only search latency unchanged.

### Fixed

- Provider-tagged sessions in mixed-workspace scenarios now correctly route artifact reads through `getProviderForSession(session)`, eliminating the implicit "always Claude" assumption that prevented mixing providers in one workspace.

### Note for users

- **This is an alpha.** Install with `npm i myrlin-workbook@alpha`. The `latest` tag still points at v0.9.36 (Claude-only stable). Feedback welcome via GitHub issues.
- **Codex CLI required for ChatGPT support.** Install `@openai/codex` separately. Myrlin only discovers and runs the CLI; it does not bundle it.
- **State auto-migrates on first launch.** No user action required. Backup files are migrated alongside the live file.

### Note for contributors

- New top-level `src/providers/` directory with one subdirectory per provider. To add a new provider, copy `src/providers/codex/` as a template, implement the 13-method `Provider` interface (see `docs/PROVIDER-INTERFACE.md`), and register in `src/providers/index.js`.
- Test count: 260+ across 24 standalone files (up from 109 in v0.9.36). New phase-specific tests live under `test/<feature>.test.js` and are wired via `test/run.js`.

## [0.9.36] - 2026-05-10

### Changed

- **Slimmed npm tarball** - The v0.9.35 tarball was 2.6 MB across 345 files because `.planning/` (GSD planning docs), `mobile/` (separate React Native app), and `logs/` (runtime logs) were not excluded from npm pack. Added all three to `.npmignore`. Also scrubbed `.planning/` from the full git history via `git filter-repo` (98 files, ~600 KB). The npm package now ships only what is needed to run the workbook.

### Note for contributors

Git history was rewritten on `main` to remove 98 ephemeral planning docs from `.planning/`. Existing clones will need to re-clone or rebase: `git fetch && git reset --hard origin/main`. All substantive commit content (code, docs, mobile app source) is preserved; only `.planning/` artifacts were removed.

## [0.9.35] - 2026-05-09

### Fixed

- **Mobile sidebar and tab strip not scrollable** - The drag-drop-touch polyfill was loaded with `?autoload`, which uses default config (no press-hold mode). Default behavior treats any touch movement on a draggable element as a drag-start. Since sidebar workspace items, session items, kanban cards, and pane tabs are all `draggable="true"`, finger swipes on those areas were intercepted as drag attempts instead of passing through to native scroll. Replaced `?autoload` with explicit `enableDragDropTouch()` call using `isPressHoldMode: true` and a 350ms press-hold delay. Drag now requires a deliberate long-press; ordinary swipes scroll.

## [0.9.34] - 2026-05-06

### Added

- **Cross-tab session pips with click-to-navigate** - Sidebar pips now show one entry per place a session is open across all tab groups (was: only the current tab). Each pip is a 10x10 two-color square: top stripe = tab's global positional color, bottom = pane slot color. Together they uniquely encode pane location. Tabs in the top strip carry a positional rainbow color (red, yellow, green, teal, blue, mauve). Click a pip to navigate to that tab+slot with a pulse animation drawing the eye to the target. Pure-data logic extracted to `instance-colors.js` (UMD wrapper). 13 new tests. Resolves #59. (PR #60 by @lreisinger)

## [0.9.33] - 2026-05-03

### Added

- **Scheduled messages** - Server-side scheduler with per-pane popover for queuing shell commands to fire into a Claude session later. Supports once-after-delay, absolute time, and recurring intervals. Persists to `~/.myrlin/schedules.json` with atomic writes. Boot recovery skips missed once-shots and advances recurring schedules without catch-up. Skip handling when PTY is stopped, with consecutive-skip collapse and 50-row history cap. Floating clock button per pane with Active/History tabs. 32 new tests across two files. (PR #55 by @lreisinger)
- **Header Height slider** - 35-80px range slider in Settings > Interface for live header bar resizing. Introduces a reusable `slider` setting type with configurable min/max/unit suffix. (PR #57 by @lreisinger)

### Fixed

- **Sessions binding to wrong Claude transcript** - Critical correctness fix. Bare spawns auto-added `claude --continue` whenever the cwd had any prior `.jsonl`, so a new Myrlin session in a busy directory resumed whichever transcript Claude considered most recent (often a sibling session's). Post-spawn detector picked the newest-mtime JSONL with no ownership check, so the wrong UUID stuck permanently. Now: drops `--continue` entirely (resume only via explicit `resumeSessionId`), uses pre-spawn JSONL snapshot + birthtime-aware hybrid `fs.watch`+rescan detector, refuses to backfill UUIDs already owned by another session, renames the misnamed `name` field to `claudeSessionId`. 6 new async watcher tests. (PR #58 by @lreisinger)
- **Shift+Enter submitting instead of inserting newline** - Sent `\n` which Ink-based TUIs (Claude Code) treat as submit. Now sends `\x1b\r` (ESC+CR) per Anthropic's `/terminal-setup` recipe, plus calls `e.preventDefault()` so the browser doesn't bypass the custom handler via xterm's hidden textarea. (PR #56 by @lreisinger)

### Internal

- **Test runner integration** - `npm test` now runs the standalone test files (`pty-watcher.test.js`, `scheduler.test.js`, `scheduler-api.test.js`) after the main suite, so CI catches failures in any of them. Total: 96 tests across 4 files.

## [0.9.32] - 2026-05-02

### Added

- **Progressive Web App (PWA) support** - Adds manifest.webmanifest with standalone display mode and a minimal service worker so users can "install" Myrlin on desktop or mobile for a native-like, full-screen experience. Requires HTTPS (typical PWA constraint). (PR #52 by @lreisinger)
- **Mobile virtual keyboard toggle** - New toolbar button toggles `inputmode="none"` on xterm.js helper textareas. For tablet users with hardware keyboards (iPad + Magic Keyboard, Android + Bluetooth) who don't want the on-screen keyboard popping up. Setting persisted to localStorage; no-op on devices without soft keyboards. (PR #53 by @lreisinger)
- **Comprehensive touch support** - Three categories of mobile/tablet fixes: (1) Touch-based pane resizing via touch events on the resize handles with widened hit areas. (2) HTML5 drag-and-drop polyfill (drag-drop-touch) so dragging sessions into panes works on iOS Safari and Android Chrome. (3) Terminal scroll gestures owned by xterm.js via stopImmediatePropagation on `.xterm-viewport` and `passive: false` listeners. Mobile detection upgraded from `innerWidth <= 768` to `navigator.maxTouchPoints` so tablet users in landscape get proper touch handling. (PR #54 by @lreisinger)

### Fixed

- **JS syntax error breaking login** - `const container` shadowed the parameter `container` in `renderTasksFilesPanel` and `renderTasksGitPanel`, causing `Identifier 'container' has already been declared` SyntaxError on login (class bodies are strict mode by default). Now reassigns the parameter directly. (PR #51 by @lreisinger)

## [0.9.31] - 2026-04-28

### Added

- **Pane view system** - Any terminal pane slot can now show a structured view (Worktree Tasks, td Issues, Git Status, Files, or Workspace Doc) instead of or alongside a terminal session. Right-click an empty pane for "Open View" submenu, or right-click an active terminal for "Switch to view" submenu. Terminal sessions keep running hidden when a view is shown and restore instantly via the back button. viewType and viewData persist in layout.json across restarts. Git Status auto-refreshes every 10 seconds. (PR #49 by @croakingtoad)

## [0.9.30] - 2026-04-27

### Fixed

- **posix_spawnp failed on macOS/Linux (reopened #4)** - The Feb fix for node-pty's spawn-helper permissions only worked when node-pty lived at `<package>/node_modules/node-pty/`. With npm hoisting and npx caches it often lives elsewhere, so the chmod was silently skipped. Postinstall now uses `require.resolve('node-pty')` to locate the actual package directory regardless of layout. Added a runtime fallback in `pty-manager.js` that re-checks and chmod's before requiring node-pty, covering `--ignore-scripts` installs and unusual cache layouts.

## [0.9.29] - 2026-04-27

### Added

- **Session titles in discovered panel** - Discovered sidebar now shows Claude's custom session names (e.g. "fix-auth-issues") instead of truncated UUIDs. Reads last 128KB of JSONL via positioned tail read with reverse scan to find the most recent `custom-title` entry. Sidebar filter, Find a Conversation, and "Add to Project" all use the title. (PR #50 by @trevorh)

### Fixed

- **API key, AI session finder, voice punctuation broken** - Three endpoints called `store.getState()` which doesn't exist; the Store exposes `state` as a getter property. Fixed all three call sites. (PR #50 by @trevorh)
- **Project paths with hook attachments resolved as missing** - 4KB head buffer in `getOriginalPathFromJsonl` was too small for hook attachment entries on line 2, truncating JSON.parse and causing path lookup to fail. Raised to 16KB with a string pre-filter. (PR #50 by @trevorh)
- **Greyed-out projects despite existing directories** - Stub sessions (1-line permission-mode only) lack a `cwd` field. Now tries multiple JSONL files in the project directory instead of only the first alphabetical one. (PR #50 by @trevorh)

## [0.9.28] - 2026-04-24

### Added

- **td panel active pane tracking** - Tasks > td tab now defaults to the focused terminal pane's project directory. New project dropdown in the toolbar lets you manually pin a specific td-initialized repo (won't follow pane changes after manual selection). Refresh button forces reload. New endpoints: `GET /api/td/projects` and `GET /api/td/issues?dir=<path>`. (PR #47 by @croakingtoad)
- **Save to Notes + Pinned Notes** - Right-click selected text in a terminal to save it as a note in workspace Docs > Notes with timestamp. Each note can be pinned to a specific terminal session via the pin button. Panes with pinned notes show a badge with count; clicking opens a master/detail modal. Persistent storage in `~/.myrlin/pinned-notes/`. (PR #48 by @croakingtoad)

### Fixed

- **td list crash on empty repos** - `td list --json` returns `null` on repos with no issues, causing `Cannot read properties of null (reading 'issues')`. Added null guard. (PR #47 by @croakingtoad)

## [0.9.27] - 2026-04-21

### Added

- **Workspace icon picker with 2,331 icons** - Workspaces can now display a Lucide (140 curated) or Material Icon (2,191) in place of the color dot. Searchable grid with categories, icon inherits workspace color. Existing workspaces without icons continue to show the color dot unchanged. (PR #44 and #46 by @croakingtoad)
- **Sidebar design polish** - Session count inline as pill badge (reduces vertical noise), active workspace left-bar uses per-workspace color, lighter italic directory group headers, sans-serif session names with inline right-aligned time, single "..." more button replacing separate rename/delete icons. (PR #44 by @croakingtoad)

### Fixed

- **Ctrl+V double-paste in terminal** - `attachCustomKeyEventHandler` returning false doesn't call `e.preventDefault()` on the DOM event, so the browser continued with native paste causing the text to send twice. Now calls `preventDefault()` in the Ctrl+V branch. Separate path from the v0.9.12 fix which only deduplicated beforeinput/paste events. (PR #45 by @croakingtoad)

## [0.9.26] - 2026-04-13

### Added

- **Tasks view with 4 sub-tabs** - New top-level "Tasks" tab with dedicated panels for Worktree Tasks (kanban board), td issues (status-grouped with detail modal and logs), Git (branch indicator, file status with inline diffs, commit log with full git-show viewer), and Files (two-pane explorer + CodeMirror 6 editor with syntax highlighting and atomic save). Switching projects in the sidebar immediately refreshes the active sub-tab. (PR #43 by @croakingtoad)
- **Git commit diff viewer** - Click any commit in the Git tab log to see full stat + patch output. 10-second auto-refresh preserves the diff pane.
- **Local CodeMirror bundle** - CodeMirror 6 served from vendor bundle instead of CDN, fixing failures for users without direct internet access.
- **td "not initialized" state** - Friendly message with "Run td init" button instead of cryptic error string.

### Fixed

- Git endpoints now resolve `workspaceId` via `resolveWorkspaceDir()` instead of failing with "dir parameter required"
- Removed duplicate route registrations that shadowed fixed endpoints
- Sidebar project switching now refreshes the active Tasks sub-tab

## [0.9.25] - 2026-04-10

### Fixed

- **Image upload broken on npx installs** - Upload directory was relative to the npm package location, which is an ephemeral cache path on npx installs. Moved to `~/.myrlin/uploads/` so saved images have a stable, predictable path that Claude Code can always read (fixes #42, reported by @hybridandrew)

## [0.9.22] - 2026-04-06

### Fixed

- **Lazy-connect terminal panes to prevent OOM** - Previously, switching to any tab group (or restoring layout) spawned ALL panes' Claude processes immediately. With 11 tab groups and 22+ panes, visiting each group accumulated 15+ Claude processes (~150MB each), exhausting system memory. Now, only the active tab group's panes auto-connect on load. Non-cached tab groups show a "Click to connect" placeholder that preserves session info in the layout. Users click individual panes to connect on demand. Layout saves preserve disconnected placeholders, so no session mapping is ever lost.

## [0.9.21] - 2026-04-06

### Fixed

- **Reverted PTY session cap and memory watchdog** - The 5-session cap and aggressive memory watchdog were killing PTY sessions and triggering layout saves that wiped pane data. Removed both limits entirely. Raised heap limit to 4GB so the server has room to breathe. The disconnected-pane preservation from v0.9.20 remains as a safety net.

## [0.9.20] - 2026-04-06

### Fixed

- **Terminal pane session info lost on PTY disconnect** - When a PTY session was killed (memory watchdog, spawn cap, or crash), `onFatalError` called `closeTerminalPane()` which set `terminalPanes[idx] = null` and showed "Drop a session here". The next debounced layout save would persist this null, permanently losing which session was assigned to that pane. Now `onFatalError` preserves the session ID, name, and spawn options in a lightweight placeholder and shows a "Disconnected. Click to reconnect." overlay instead. Layout saves include these disconnected panes so no session mapping is ever lost.

## [0.9.19] - 2026-04-06

### Fixed

- **Repeated heap OOM crashes (exit code 134)** - ConPTY on Windows allocates heavy native memory outside V8's heap, so `--max-old-space-size` alone cannot prevent OOM. Reduced max concurrent PTY sessions from 10 to 5. Lowered memory watchdog thresholds (warn at 200MB, critical at 350MB) and increased check frequency to every 15 seconds. Added periodic RSS logging every 60 seconds to `server.log` so memory trajectory is always visible for debugging.

## [0.9.18] - 2026-04-06

### Fixed

- **Daemon mode process still killed when parent shell exits (Windows)** - Node.js `detached: true` does not escape the parent console session's Job Object on Windows. When the launching shell (Git Bash, Claude Code) exits, Windows kills the entire job group including the "detached" supervisor. Now uses `cmd.exe /c start /b` on Windows to create the process in a completely new console session that is truly independent of the parent. Verified: the supervisor's parent PID becomes orphaned (non-existent), so no parent death can cascade.

## [0.9.17] - 2026-04-06

### Fixed

- **Server OOM crash from unbounded PTY sessions** - The frontend auto-reconnects all terminal panes on page load, which could spawn 20-30 Claude processes simultaneously (each 100-200MB). The OS silently killed the entire process tree with no crash log. Added a hard cap of 10 concurrent PTY sessions; spawns beyond the limit are rejected with a message to the client. Also added a memory watchdog that monitors RSS every 30 seconds and kills idle (zero-client) PTY sessions when memory exceeds 350MB, with more aggressive cleanup at 450MB. Supervisor now launches gui.js with `--max-old-space-size=1024`.
- **Login spinner stuck after entering password** - `_initializeApp()` awaited `initTerminalGroups()` which restores all terminal panes synchronously, spawning multiple PTY sessions. The login button stayed in loading state until all terminals connected. Terminal group restore is now non-blocking; the UI appears immediately while terminals reconnect in the background.

## [0.9.15] - 2026-04-06

### Fixed

- **Server crashes when parent shell exits** - On Windows, backgrounding the server with `&` does not detach the process tree. When the parent bash/terminal session ends, the server dies silently (no crash log, no restart). Added `--daemon` mode to the supervisor that re-spawns itself fully detached with stdio redirected to `logs/server.log` and a PID file at `logs/server.pid`. Use `npm run gui:daemon` or `node src/supervisor.js --daemon`.
- **EPIPE cascade kills server** - When stdout/stderr pipe breaks (parent process gone), the `uncaughtException` handler called `console.error()`, which threw another EPIPE, creating an infinite exception loop. Added EPIPE error handlers on `process.stdout` and `process.stderr` in both `gui.js` and `supervisor.js`. Wrapped all console calls in exception handlers with try/catch as a secondary guard.

## [0.9.24] - 2026-04-08

### Removed

- **"Click to connect" disconnected placeholders** - Removed the lazy-connect placeholder system entirely. It caused cascading issues: reconnect opened in wrong pane, panes couldn't be closed, layout saves broke for placeholder entries. Terminal panes now connect directly on restore (initial load and tab group switch). Fatal connection errors close the pane cleanly instead of leaving an unclosable placeholder.

## [0.9.23] - 2026-04-07

### Fixed

- **"Click to connect" opens new pane instead of reconnecting in place** - After restart, clicking the reconnect placeholder opened the session in a different empty pane because `openTerminalInPane` saw the placeholder object as an occupied slot and redirected. Now detects disconnected placeholders and clears them so the session reconnects in the same slot.

## [0.9.14] - 2026-04-02

### Fixed

- **Input lag from sidebar re-renders during cost updates** - When batch cost data arrived, the entire sidebar was rebuilt via `renderWorkspaces()` (every workspace, session, badge, and event handler). With 20+ sessions, this DOM rebuild froze the browser for hundreds of milliseconds. Now patches cost badge text in-place without touching the rest of the DOM.

## [0.9.13] - 2026-04-01

### Added

- **Voice dictation punctuation** - Voice input now adds proper punctuation, capitalization, and grammar before sending text to the terminal. Uses Claude Haiku via the configured Anthropic API key for accurate cleanup. Falls back to basic rule-based capitalization and period insertion when no API key is configured.

## [0.9.12] - 2026-04-01

### Fixed

- **Right-click and menu paste broken in terminal** - The v0.9.4 double-paste fix (PR #34) blocked all native paste events but only provided Ctrl+V/Cmd+V as an alternative. Right-click > Paste, browser Edit > Paste, and touch-paste were completely non-functional. Now intercepts native paste events, extracts the clipboard text, and routes it through the WebSocket with proper bracketed paste sequences. Deduplication flag prevents double-send when both beforeinput and paste events fire.

## [0.9.11] - 2026-04-01

### Fixed

- **App freezes during cost calculation** - All cost endpoints (batch, dashboard, quota overview, workspace cost, session export) were calling `calculateSessionCost()` synchronously, which reads and parses entire JSONL files on the main event loop. With large session files, this blocked all HTTP, SSE, and WebSocket traffic for several seconds, freezing the entire UI. Now uses the existing worker thread (`cost-worker.js`) via `calculateSessionCostAsync()` for all cache-miss calculations, keeping the event loop free. Cache hits (the common case) still return instantly with zero I/O.

## [0.9.10] - 2026-04-01

### Added

- **Android build configuration** - Added package name, SDK targets (API 24-35), permissions (camera, mic, storage, notifications, network), and production AAB build type to unblock EAS Android builds. Fixed Maestro test appId to match the correct package name (PR #40 by @croakingtoad)

## [0.9.9] - 2026-03-28

### Fixed

- **Missing data-dir.js crashes server on startup** - `src/utils/data-dir.js` was referenced by store.js but never committed, causing MODULE_NOT_FOUND on fresh installs. State now persists to `~/.myrlin/` so all launch methods (npm, npx, global) share the same data. Includes one-time migration from legacy project-local `./state/` directory. Override with `CWM_DATA_DIR` env var for custom installs (fixes #39, reported by @inorixu, PR #38 by @b2r66sun)

## [0.9.8] - 2026-03-26

### Fixed

- **Session name in terminal pane titles** - Discovered sessions opened via drag-and-drop or context menu now show the custom renamed title instead of the raw Claude session UUID. Falls back to UUID when no custom name exists (PR #37 by @snmo2546)

## [0.9.7] - 2026-03-19

### Added

- **Home directory expansion** - Session working directories now support `~/path` syntax on all platforms. The `~` is expanded to the user's home directory at session creation time (PR #36 by @inorixu)
- **CJK path support** - Projects with Chinese, Japanese, or Korean characters in their paths are now discovered and displayed correctly. Falls back to reading the original path from JSONL session data when UTF-8 decoding fails (PR #36 by @inorixu)

## [0.9.6] - 2026-03-16

### Fixed

- **Duplicate terminal panes on restart** - Saved pane layouts were restored twice due to an unwaited async race condition. `loadTerminalLayout()` fired without being awaited, so pane restoration raced against subsequent initialization. The second restore found the target slots occupied and spilled into empty slots, doubling the pane count. Fixed by awaiting layout load before continuing init, and adding slot-occupied guards in both restore paths (fixes #35)

## [0.9.5] - 2026-03-16

### Fixed

- **Cost request spam on page load** - Session costs were fetched with individual HTTP requests per session (N+1 pattern), causing 20+ requests on every page load and tab switch. Replaced with a single batch endpoint `GET /api/cost/batch` that returns all session costs in one response. Sidebar only re-renders when cost values actually change, eliminating the render loop.

## [0.9.4] - 2026-03-13

### Fixed

- **Double paste in terminal** - Pasted text was sent twice via WebSocket because both the custom Ctrl+V handler and xterm.js native paste processing fired. Now blocks xterm.js native `insertFromPaste` events since we handle paste manually with bracketed paste sequences (PR #34 by @benoitmidon)

## [0.9.3] - 2026-03-12

### Fixed

- **Header logo broken on npx install** - Header referenced `logo-cropped.png` which was excluded from the npm package. Changed to `logo.png` for consistency with the login page (fixes #33, reported by @dianshu)

## [0.9.2] - 2026-03-12

### Fixed

- **Cost dashboard period totals** - "Last 24 hours", "Last 7 days", and "Last month" were counting the entire lifetime cost of any session active within the window, instead of only the cost incurred during that period. Now apportions cost per message using timestamps, so each period reflects only the spending that actually happened within it.

## [0.9.1] - 2026-03-11

### Added

- **One-time startup token** - Auto-login URL now uses a single-use, 60-second token instead of the plaintext password. Token is consumed on first use and cannot be replayed. The actual password never appears in URLs, terminal scrollback, or process listings (PR #28 by @dianshu)
- **Model aliases** - All model pickers now use official Claude Code aliases (opus, sonnet, haiku, sonnet[1m], opusplan) that auto-resolve to the latest version. Added Sonnet 1M and OpusPlan options (PR #31 by @croakingtoad)

### Fixed

- **Shell glob expansion bug** - `sonnet[1m]` was being mangled by bash before reaching Claude. Model values are now single-quoted in PTY commands (PR #31 by @croakingtoad)
- **Terminal "undefined" prefix** - Write buffers initialized in constructor to prevent "undefinedConnecting to session..." on first mount (PR #31 by @croakingtoad)
- **Missing crash-logger** - `src/crash-logger.js` was never committed, causing MODULE_NOT_FOUND in uncaught exception handlers (fixes #32, reported by @croakingtoad)

## [0.9.0] - 2026-03-10

### Added

- **AI-powered session finder** - "Find a Session" now uses Claude Haiku to semantically match natural language descriptions against all your projects and sessions. Describe what you're looking for ("that React auth project from last week") and get ranked results with AI-generated explanations of why each matches. Results appear as rich cards with confidence scores, project path, last active time, and session count. Click any card to open it in a terminal pane; results stay on screen so you can open multiple sessions. Falls back to keyword matching when no API key is configured.
- **Anthropic API key setting** - New "AI" category in Settings for configuring your Anthropic API key (used by the session finder). Key is stored server-side and displayed masked.

## [0.8.10] - 2026-03-10

### Fixed

- **Launcher "workspaceId is required" error** - Fixed session creation from the Launcher failing when the selected project had no existing sessions. The Launcher now matches workspaces by name as a fallback, and auto-creates a new workspace if no match is found (fixes #30, reported by @falceso)

## [0.8.9] - 2026-03-09

### Added

- **Hidden items management** - Hide projects, categories, and sessions from the sidebar via right-click context menu. Manage all hidden items in Settings > Hidden Items with one-click unhide or "Unhide All". Hidden items shown with dimmed opacity when "Show hidden" is toggled.

## [0.8.8] - 2026-03-09

### Added

- **Two-stage terminal pane expand** - Expand button on each terminal pane header cycles through: normal, grid-fill (stage 1), and full viewport (stage 2). Collapse button returns to normal. Escape key collapses expanded panes as lowest-priority action in the key cascade (PR #29 by @croakingtoad, with fixes)

### Fixed

- **Pane expand z-index collision** - Stage 2 z-index lowered from 1000 to 900 so overlay panels (session manager, conflict center, modals) remain accessible when a pane is expanded
- **Escape handler conflict** - Pane collapse moved from standalone listener into the main Escape cascade, preventing double-firing when overlays are open

### Improved

- **Smooth expand/collapse transitions** - 150ms ease transition on expand/collapse for visual consistency with the rest of the UI

## [0.8.7] - 2026-03-07

### Fixed

- **Terminal input freeze** - Deferred store lastActive updates off the PTY data path with `setImmediate` to prevent synchronous JSON I/O from blocking WebSocket sends during active output
- **CPU waste on background terminals** - Activity detection regex (ANSI strip + tool matching) now skips unfocused terminal panes
- **Image upload unauthorized** - Upload handler referenced `this.authToken` instead of `this.state.token`, causing all image uploads to fail with 401

### Improved

- **Image drag-and-drop UX** - Terminal pane blurs and dims when dragging an image over it, with a labeled pill overlay ("Drop image to send to this session") so it's clear which session receives the file

### Added

- **Restart Session** - Right-click context menu option on terminals to kill and relaunch a session in-place (picks up MCP config changes, settings updates, etc.)

## [0.8.6] - 2026-03-08

### Fixed

- **npx install failure** - `scripts/postinstall.js` was excluded from the npm package by `.npmignore`, causing `MODULE_NOT_FOUND` on `npx myrlin-workbook`. Fixed by excluding only dev scripts instead of the entire `scripts/` directory (#27, reported by @dianshu)

## [0.8.5] - 2026-03-07

### Added

- **td task management integration** - Optional td binary integration for task tracking in the docs panel. Toggle in Settings, configure binary path. Includes issue detail modal and sidebar toggle (PR #26 by @croakingtoad)
- **Initial prompt and flags passthrough** - Worktree sessions now pass through initial prompt and CLI flags (e.g. `--verbose`, `--agent-teams`) to the PTY on first launch (PR #26)
- **Worktree task records** - Track worktree lifecycle (branch, path, status, tags) with dedicated API endpoints (PR #26)

### Fixed

- **createSession workspaceId** - Pass workspaceId inside the options object instead of as a separate argument (PR #22 by @croakingtoad)
- **--continue without history** - Skip `--continue` flag when the working directory has no prior Claude JSONL history (PR #23 by @croakingtoad)
- **Worktree branch collision** - Handle "branch already checked out" error during worktree creation by detecting and skipping (PR #24 by @croakingtoad)
- **Worktree path collision** - Skip `git worktree add` if path is already registered as a worktree (PR #26)
- **Worktree repo root resolution** - Resolve td repo dir to main repo root for git worktrees (PR #26)
- **Flag checkbox values** - Strip leading `--` from flag checkbox values to avoid double-dash when constructing CLI args (PR #26)

## [0.8.3] - 2026-03-07

### Fixed

- **New project "+" button** - The dropdown menu was immediately closing due to an event-bubbling race condition. The document-level click handler dismissed the menu before it could render. Fixed by stopping propagation on the button click (#20)
- **Cross-process state sync** - Projects created in the TUI never appeared in the GUI because each process had its own in-memory state. Added mtime-based disk sync so the GUI re-reads state when another process modifies the file (#20)
- **Concurrent write safety** - Atomic write temp files now use PID-unique filenames to prevent collisions when TUI and GUI write simultaneously

### Added

- **Git concurrency pool** - Limits concurrent git child processes to 3, preventing resource exhaustion when polling many sessions
- **Express error middleware** - Catch-all error handler prevents unhandled route errors from crashing the server
- **Directory validation** - Git status endpoint validates directory exists before spawning git processes
- **Restart Session** - Terminal context menu now has a "Restart Session" option that kills and relaunches in-place

## [0.8.2] - 2026-03-02

### Fixed

- **Sidebar chevrons** - Project directory group arrows now correctly point right (collapsed) and down (expanded), matching the workspace accordion pattern
- **Accordion persistence** - Collapsed workspace accordions no longer randomly re-open on SSE re-renders. Collapse state is persisted to localStorage
- **New session resume bug** - Right-click "New Session Here" on project directories now starts a fresh Claude session instead of resuming the most recent one via `--continue`

### Changed

- **+ button dropdown** - The sidebar + button now offers both "New Project" and "New Category" options via a dropdown menu
- **Visual divider** - Added an "Uncategorized" divider between category groups and ungrouped projects in the sidebar
- **Removed workspace nesting** - Removed "Set Parent" and "Remove Parent" from the workspace context menu. Use Categories for grouping instead, which is simpler and less confusing

## [0.8.1] - 2026-02-24

### Added

- **Change Environment (shell switcher)** -- Right-click any terminal pane to switch the Claude session's shell environment. On Windows: CMD, PowerShell, PowerShell 7 (pwsh), and Git Bash (auto-detected). On macOS/Linux: Bash, Zsh, Fish. The current shell is indicated with a checkmark. Switching kills the PTY and relaunches in the same pane slot with the new shell. Shell preference persists across tab group switches and layout restores. All shell names validated against strict allowlists for security.

## [0.8.0] - 2026-02-23

### Added

- **6-pane terminal grid** -- Expanded from 4 to 6 terminal panes with smart CSS grid layouts. Pane count auto-adapts: 1x1, 2x1, 2+1span, 2x2, 3+2span, 3x2. New `MAX_PANES` constant replaces all hardcoded loop bounds. Slot colors extended with red and pink for panes 5-6.
- **Launch New Session button** -- Sidebar button opens a frecency-ranked project launcher modal. Shows Pinned/Recent/All sections, fuzzy search across project names and paths, pin persistence via localStorage, CLAUDE.md badges, session name input, and model selector. Creates sessions directly and opens them in a terminal pane.
- **Voice/mic input** -- Web Speech API integration for Chrome/Edge. Mic button on each terminal pane header starts speech recognition, shows live interim transcript overlay, and sends final transcript to the terminal WebSocket. Pulses red while listening. Respects `prefers-reduced-motion`. Gracefully hidden on unsupported browsers.
- **Conflict detection** -- JSONL-based global conflict detection across all active sessions. Backend scans the last 50KB of each session's JSONL for `Write` and `Edit` tool_use blocks, identifies overlapping file modifications across sessions. Amber pill badges on terminal pane headers show conflict count. Toast notifications for new conflicts (deduplicated). Context menu "Conflicts (N)" item shows file details. 30-second backend cache, 60-second frontend polling.

### Fixed

- **Tab pane layout bleeding** -- Switching to a new empty tab group no longer shows the previous group's multi-pane grid layout. Added `updateTerminalGridLayout()` call after cache restore/fresh-connect to always reset grid for the new group's pane count.

## [0.7.0] - 2026-02-23

### Added

- **Task Spinoff** -- Right-click any session and select "Spinoff Tasks" to AI-extract independent, actionable tasks from the session's conversation history. The AI analyzes the conversation (via `claude --print`) and returns structured task specs with title, description, relevant files, acceptance criteria, and suggested branch names. Review and edit tasks in a modal with select/deselect checkboxes, inline-editable titles and descriptions, file badges, and criteria lists. Batch-create as worktree tasks (immediate start or backlog). Each spinoff task gets the "spinoff" tag for tracking.
- **Backend endpoints**: `POST /api/sessions/:id/extract-tasks` (AI conversation analysis), `POST /api/sessions/:id/spinoff-context` (rich context package generation with file snippets, project structure, CLAUDE.md, and git history), `POST /api/sessions/:id/spinoff-batch` (batch worktree task creation with worktree init hooks).
- **Spinoff dialog CSS**: Animated loading dots, task cards with deselected state, editable inputs, file badges, acceptance criteria lists.
- **Cloudflare named tunnel integration** -- UI setup guide and configuration for persistent remote access via Cloudflare Tunnels.

### Fixed

- **Notification dot not clearing** -- Tab group notification dots now clear properly when clicking the tab. Root cause: trivial PTY output was re-triggering `terminal-idle` events after the user acknowledged them.
- **CJK composition duplicate input** -- Korean and other CJK IME input no longer duplicates the last composed character. Removed conflicting composition event handlers, letting xterm.js's built-in CompositionHelper own IME handling. (Thanks @ntopia)
- **Linux/macOS path decoding** -- `decodeClaudePath` now correctly resolves Linux/macOS encoded paths (e.g., `-home-vivi-pingterra` to `/home/vivi/pingterra`). Extracted shared `greedyFsWalk` helper. (Thanks @Vidalee)
- **Mobile terminal scroll snap-back** -- Touch scrolling no longer snaps back to the bottom on new PTY output. Switched from direct `scrollTop` manipulation to `term.scrollLines()` API to keep xterm.js internal state in sync. Time-based momentum decay for consistent feel across refresh rates. (Thanks @Vidalee)
- **Null session guard** -- PTY `attachClient` now guards against null sessions from `spawnSession`, preventing crashes on edge-case connection failures.

## [0.7.0-alpha.12] - 2026-02-21

### Added

- **Pull request automation** -- Create GitHub PRs directly from worktree tasks via `gh` CLI. PR creation modal with title, AI-generated description (via `claude --print`), base branch selector, labels, and draft toggle. PR badges on kanban cards link to GitHub with state coloring (green=open, grey=draft, mauve=merged, red=closed). "Create PR" button in review column, kanban context menu, and session detail banner. Auto-advances tasks to Done when PR is merged. "Refresh PR Status" and "View PR" actions for existing PRs.

## [0.7.0-alpha.11] - 2026-02-21

### Added

- **Cross-cutting tag system** -- Add comma-separated tags to tasks and sessions. Tags appear as color-coded badges (Catppuccin palette hash) on kanban cards and session list. Searchable via task filter. Edit tags via right-click context menu on kanban cards or sessions. Tags input in New Task dialog.
- **Multi-model orchestration** -- Change a task's model from the kanban card context menu. Configure default models for Planning and Running stages in Settings > Advanced. Tasks without a model auto-inherit the stage default when dragged between columns. Model dropdown options show cost/speed hints.
- **Agent teams UX** -- New Task dialog includes agent teams checkbox and collapsible "How agent workflows work" panel explaining single-agent vs model-per-stage vs agent teams tradeoffs. Kanban cards show stage progress dots (workflow progression indicator). Settings model dropdowns include descriptive hints.
- **Select-type settings** -- Settings renderer now supports dropdown select inputs in addition to toggles, numbers, and scales.

## [0.7.0-alpha.10] - 2026-02-21

### Added

- **Sidebar Projects/Tasks toggle** -- New toggle pill at the top of the sidebar switches between Projects (project/session tree) and Tasks (compact worktree task list). Tasks view shows running/review/backlog status dots. Click any task to jump to the kanban board.
- **Agent count badges on kanban cards** -- Running task cards now show a teal "N agents" badge when the session has active subagents, using the existing subagent detection cache.

## [0.7.0-alpha.9] - 2026-02-21

### Added

- **Planning kanban column** -- 5-column kanban board: Backlog | Planning | Running | Review | Done. The Planning column (mauve) is for exploration and design work before committing to active development.
- **Worktree init hooks** -- Configure `copy_files` (array of relative paths like CLAUDE.md, .env.example) and `init_script` (shell command) that run automatically when new worktree tasks are created. API: `GET/PUT /api/worktree-init-hooks`.

## [0.7.0-alpha.8] - 2026-02-21

### Added

- **Task dependencies** -- Right-click a kanban card to set "blocked by" relationships with other tasks. Blocked tasks show a red indicator and are visually dimmed. Dependencies are toggled individually or cleared in bulk.
- **Timeline audit trail** -- Every status transition (backlog -> running -> review -> done) is recorded with timestamp. Completed tasks show "N transitions -- Xh Ym total" duration on cards. Full timeline viewable via right-click context menu.
- **Concurrent task limits** -- New "Max Concurrent Tasks" setting (1-8, default 4) in Settings > Advanced. Enforced when starting new tasks and when dragging to the Running column.
- **Kanban card context menu** -- Right-click cards to manage dependencies, view timeline, or delete tasks.
- **Task backlog API** -- Server now supports `startNow: false` to create tasks without provisioning worktree or session, placed directly in backlog.

## [0.7.0-alpha.7] - 2026-02-21

### Added

- **Task search and filtering** -- Filter input in the tasks panel header filters cards by branch, description, model, or status across both board and list layouts.
- **"Open All in Tab" context menu** -- Right-click a project and select "Open All in Tab" to create a new tab group with up to 4 sessions from that project opened automatically.
- **GitHub-style kanban cards** -- Colored left border accent per status column (grey=backlog, green=running, amber=review, blue=done), subtle hover lift animation, and 2-degree rotation during drag.
- **Live session preview** -- Running task cards in the kanban board show the last line of terminal output in a monospace preview strip, updated on each board render.
- **Task backlog support** -- New Task dialog has "Start immediately" checkbox. Uncheck to create a task in the backlog column without provisioning a worktree or session. Start it later by dragging to Running.
- **Task description field** -- New Task dialog now includes an optional description field for additional context.

## [0.7.0-alpha.6] - 2026-02-21

### Added

- **Kanban board view** -- Worktree tasks now display in a horizontal kanban board with 4 columns: Backlog, Running, Review, Done. Cards are draggable between columns to change task status. Each card shows branch name, model badge, relative time, and change statistics. Column-specific action buttons (Open Terminal, Merge, Diff, Push).
- **Tasks layout toggle** -- Switch between board (kanban) and list view via toggle buttons in the tasks panel header. Preference persisted to localStorage. Board is the default.
- **CORS hostname security fix** -- Tightened the LAN/Tailscale CORS hostname check from PR #6 to use exact hostname comparison via URL parsing instead of substring matching, preventing bypass attacks like `192.168.1.100.evil.com`.

## [0.7.0-alpha.5] - 2026-02-21

### Changed

- **Organizational hierarchy renamed** -- "Workspace Groups" are now "Categories", "Workspaces" are now "Projects", child workspaces are "Focuses". The 3-level hierarchy is: Category > Project > Focus > Sessions. All user-visible UI labels updated across ~90 strings (toasts, modals, context menus, command palette, sidebar, cost dashboard, README).
- **"Discovered" section renamed** -- The auto-discovered sessions section (formerly "Projects") is now "Discovered" to avoid collision with the new "Projects" terminology.
- **README updated** -- New hierarchy diagram, terminology throughout, roadmap split into Coming Soon/Shipped, test count updated to 42.

### Added

- **3-pane grid layout fix** -- When 3 terminals are open, the bottom pane now spans both columns (no wasted empty quadrant). Uses CSS `grid-column: span 2` on the last filled pane.

## [0.7.0-alpha.4] - 2026-02-20

### Fixed

- **Mobile input row visible on desktop** -- The "Type here... / Send" input row from PR #6 had no base `display: none` rule, so it showed on desktop browsers. Now hidden by default in `styles.css`, only shown on mobile via `styles-mobile.css`.

## [0.7.0-alpha.3] - 2026-02-20

### Fixed

- **Tab group pane layout bleeding** -- Switching from a multi-pane tab group to a single-pane tab group and back no longer collapses all panes to one. Root cause: CSS `.terminal-pane { display: flex }` overrode the browser UA `[hidden] { display: none }` rule, making `paneEl.hidden = true` ineffective for hiding grid slots during tab switches. Added `.terminal-pane[hidden] { display: none !important; }` override and explicit `paneEl.hidden = false` in the restore-from-cache path.

### Added (merged from PR #6 by @jfrostad)

- **Mobile scrollbar hiding** -- Hides scrollbars on mobile to prevent layout interference.
- **Dedicated mobile input field** -- Touch-friendly input row with Send button replaces unreliable virtual keyboard interaction.
- **IME composition guard** -- Prevents partial input submission during autocorrect/IME composition.
- **xterm textarea attributes** -- Sets `autocomplete=off, autocorrect=off, autocapitalize=off, spellcheck=false` on xterm textareas.
- **LAN/Tailscale CORS** -- Dynamic CORS and CSP headers for local network access.

## [0.7.0-alpha.2] - 2026-02-20

### Added

- **Session item two-line layout** â€” Session names display on their own line with badges, size, and time on a second row underneath. Removes 22-character name truncation.
- **Auto-trust & question detection** â€” Automatically accepts safe trust/permission prompts (Y/n, trust folder, proceed, allow tool access) with 12 danger keyword guards (delete, credential, password, etc.). Amber "Needs input" badge on pane header for dangerous prompts. Opt-in via Settings > Automation.
- **Tri-state status dots** â€” Worktree task sessions show pulsing green (active), amber (idle/waiting), or blue checkmark (done with commits) in sidebar. Server enriches tasks with `branchAhead` and `changedFiles` counts.
- **Worktree Tasks view** â€” Dedicated "Tasks" sidebar view mode showing tasks grouped by Active/Review/Completed with quick actions (Open, Merge, Diff, Push).
- **New Task dialog** â€” Full-featured task creation with auto-detected project directories, live branch name preview, model selector, flag checkboxes, and initial prompt.
- **Workspace hover button** â€” Hover over a workspace to show a `+` button for quick worktree task creation.
- **Changed files API** â€” `GET /api/worktree-tasks/:id/changes` returns per-file additions, deletions, and status (A/M/D/R).
- **Per-file diff API** â€” `POST /api/worktree-tasks/:id/diff` now accepts optional `file` field for single-file diffs.
- **Diff viewer modal** â€” Full diff viewer with file list sidebar (status icons, +/- counts), syntax-highlighted unified diff, hunk headers, and line numbers.
- **Changed files in session detail** â€” Collapsible "Changed Files" section below worktree task review banner with click-to-open-diff.
- **One-click merge dialog** â€” Merge dialog with squash toggle, custom commit message, and push-to-remote option. Replaces simple confirm modal.
- **Branch push endpoint** â€” `POST /api/worktree-tasks/:id/push` pushes branch to remote for PR workflows. Push button in review banner and Tasks view.
- **Workflows documentation** â€” Comprehensive `docs/WORKFLOWS.md` covering all features with user stories and step-by-step guides.
- **16 new unit tests** â€” Auto-trust pattern matching (10 tests), diff parsing (4 tests), numstat parsing (2 tests). Total: 42 tests.

## [0.7.0-alpha.1] - 2026-02-20

### Fixed

- **Tab group switch blank canvas** â€” Switching from a 4-pane tab group to a 1-pane group and back caused all 4 terminals to appear blank. Canvas pixel buffer was cleared when xterm.js DOM was moved to DocumentFragments for caching. Added explicit `term.refresh()` after restoring cached panes.
- **Discover Sessions "Import Selected"** â€” Clicking "Import Selected" in the Discover Claude Sessions modal did nothing. The confirm button had no click handler wired to resolve the promise.
- **Dead terminal panes filling grid** â€” Saved layouts with stale sessions showed a multi-pane grid with dead terminals. Panes now auto-close after fatal connection errors (max retries or server error 1011).
- **Mobile terminal scrolling** â€” Swiping on the terminal body now scrolls with native-feeling momentum. Manual touch-scroll handler bypasses xterm.js's touch event interception that was blocking native scroll. Long-press (400ms) activates text selection without triggering keyboard. Scrollbar now visible and draggable on mobile.

### Added

- **Inspect Element** â€” Right-click anywhere shows "Inspect Element" and "Copy Selector" for developer access. Uses Chrome DevTools `inspect()` when available, falls back to console logging.
- **Organized context menus** â€” Session context menu items grouped into submenus (Naming, Insights, Advanced) to reduce clutter from ~18 flat items to ~12 grouped items.

### Removed

- **Weekly usage quota widget** â€” Fully removed (sidebar progress bars, polling, settings, API endpoint). Code archived to `docs/QUOTA_WIDGET_REFERENCE.md` for future re-implementation. Context window tracking in session detail and Resources panel retained.

## [0.6.0] - 2026-02-20

### Added

- **Command Palette** â€” Ctrl+K now searches sessions, workspaces, features, actions, settings, and keyboard shortcuts. Type `>` for command mode (actions only), press `?` or `F1` for help mode (browse all features). Color-coded result badges per type (session/workspace/action/feature/setting/shortcut) with keyboard shortcut indicators.
- **Feature Discovery** â€” 30+ feature catalog entries covering every capability in the app. Users can search "worktree", "template", "cost", etc. to discover features they didn't know existed. Settings are also searchable from the palette.
- **Worktree Task Automation** â€” Create isolated worktree branches for Claude to work on autonomously. Right-click workspace > "New Worktree Task" (requires opt-in via Settings > Advanced). Auto-creates git worktree + branch + session. When session stops, task auto-transitions to "review" status with View Diff / Merge / Reject / Resume actions in the session detail panel. Merge cleans up the worktree and branch automatically.
- **Worktree Tasks API** â€” Full CRUD endpoints: GET/POST/PUT/DELETE `/api/worktree-tasks`, plus `/merge`, `/reject`, `/diff` action endpoints. SSE events for real-time updates.

## [0.5.0] - 2026-02-18

### Added

- **Refocus Session** â€” right-click any session to distill the full conversation into a structured context document, then Reset (clear + reinject) or Compact (compress + reinject) the session. Gives Claude a fresh context window with full project awareness.
- **Unified Context Menus** â€” terminal pane right-click now includes all session management options (Start/Stop, Model, Flags, Rename, Summarize, Templates, Move to Workspace, etc.) matching the sidebar context menu.
- **Persistent Password Config** â€” password can now be set in `~/.myrlin/config.json` for automatic startup without prompts.
- **Cross-Platform Support** â€” merged community PR for WSL/Linux shell spawning. Shell selection, browser launch, and demo paths now work on Windows, Linux, and macOS.
- **Security Hardening** â€” three-layer input validation (API boundary, WebSocket boundary, spawn point) for command injection prevention. Shell allowlist for safe binary selection. HTML escaping for template chip tooltips.

### Fixed

- **Terminal Scrollback Preserved on Tab Switch** â€” hidden terminal panes no longer get resized to 1x1 when switching tabs, which was permanently garbling scrollback. All 9 fit() call sites now use visibility-guarded `safeFit()`.
- **Mobile Terminal Scroll** â€” native compositor-thread scrolling for 60fps smooth mobile scrolling.
- **Session Rename Persistence** â€” renaming a session (via context menu, inline edit, or auto-title) now syncs the new name to terminal pane tabs, sidebar, and project views globally.

## [0.4.1] - 2026-02-16

### Fixed

- **Login Logo Restored** - login page uses original full logo at 420px. Header and README use cleaned cropped logo (no black background). Separate image files for login vs header.

## [0.4.0] - 2026-02-16

### Added

- **5 New Themes** - Nord, Dracula, Tokyo Night (dark), Rose Pine Dawn, Gruvbox Light (light). Now 13 themes total.
- **Theme Dropdown Sections** - Dark and Light categories with section headers. Official Catppuccin themes marked with star badge.
- **Cropped Logo** - updated app header and README with larger cropped logo (64px header, 250px README).

### Fixed

- **Project Discovery with Spaces** - directories with spaces in names (e.g. "Work AI Project") now correctly discovered. `decodeClaudePath()` tries space-joined candidates alongside hyphen-joined.
- **Marketing Scripts Removed from Repo** - internal scripts and strategy docs properly gitignored and untracked.

## [0.3.0-alpha] - 2026-02-16

### Added

- **Session Manager Overlay** - click running/total session counts in header to open a dropdown panel. Mass-select sessions, batch stop, filter (All/Running/Stopped), one-click terminal open. If session is already in a pane, activates it.
- **Conflict Center UI** - clickable warning badge in header shows conflicting file count. Click to open overlay with per-file breakdown showing which sessions edit each file. Click a session chip to jump to its terminal pane.
- **Tab Close Buttons** - X button on desktop tab group tabs. Confirmation dialog when live sessions exist; kills PTY sessions on confirm.
- **Drag-and-Hold Tab Grouping** - hold a tab over another for 1.2 seconds to auto-create a folder containing both tabs. Pulsing glow visual feedback. Joins existing folder if target is already grouped.
- **Costs Dashboard Tab** - replaced "All" tab with "Costs". Full cost dashboard with period selector (Day/Week/Month/All), summary cards, SVG timeline chart, model/workspace breakdown, sortable session table.
- **Workspace Group Improvements** - groups render at top, tinted backgrounds using `color-mix()`, larger headers, indented children with accent border.
- **4 Additional Themes** - expanded to 8 total Catppuccin flavors.

### Fixed

- **Terminal Flashing** - deduplicated `updatePaneActivity()` DOM writes; skips innerHTML when content unchanged.
- **Bracketed Paste** - pasted text now wrapped in ESC[200~/ESC[201~ so shells correctly handle special characters.
- **Cost Dashboard Accuracy** - raised JSONL file size limit from 10MB to 500MB; large sessions were silently skipped.
- **Terminal Session Restore** - `--continue` fallback when `resumeSessionId` is null; async UUID detection after PTY spawn.
- **Session `lastActive`** - now correctly updates on workspace refresh.

## [0.2.0] - 2026-02-16

### Added

- **Visual QA MCP Server** (`src/mcp/visual-qa.js`) - gives Claude "eyes and hands" for web UI development via Chrome DevTools Protocol. 4 tools: `screenshot`, `query_dom`, `execute_js`, `list_targets`. Works with any browser or Electron app that exposes a CDP debugging port.
- **`--cdp` flag** for GUI launcher - `npm run gui:cdp` launches browser with `--remote-debugging-port=9222` so the Visual QA MCP can connect automatically.
- **`npm run mcp:visual-qa`** script to run the MCP server standalone.
- `chrome-remote-interface` dependency for lightweight CDP access (~50KB).
- Registered `visual-qa` MCP server globally in Claude Code settings.
- Added Visual QA workflow documentation to global CLAUDE.md for use across all web/UI projects.

## [0.1.0] - 2026-02-01

### Added

- Initial release: TUI + GUI workspace manager for Claude Code sessions.
- Session discovery, multi-terminal PTY, cost tracking, templates, docs panel, search.
- 4 Catppuccin themes (Mocha, Macchiato, Frappe, Latte).
- Cross-tab terminal dragging, tab group folders, mobile support.
