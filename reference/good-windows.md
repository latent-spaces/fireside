# What makes a good window

Fireside is meant to be comfortable. A good window is easy to read, nice to look
at, and saves the user steps. Open one whenever the user asks for it or it would
make something easier; there is no need to justify it. These are habits that
help, drawn from usability and learning research (sources at the end), not rules
to pass.

## Save the user work

The best window is one that leaves the user less to do.

- **Text to copy goes in a window with a Copy button**: a command, a message to
  send, a config snippet. One click beats selecting text in the chat. (Sketch
  below.)
- **The next step is a button.** `<button data-prompt="…">` drafts the prompt,
  so acting on what they see is one click.
- **Actions sit on the things they apply to**: each email gets its own "Draft a
  reply", each failing test its own "Fix this".
- **Links open the thing**: a file, the page, the original email.
- Things the user types or arranges stay put; never overwrite them.

```html
<pre id="t">git commit -m "Fix the login redirect"</pre>
<button onclick="navigator.clipboard.writeText(t.textContent);this.textContent='Copied ✓'">Copy</button>
```

## Show the thing itself

People take in pictures with words faster than words alone (Mayer's multimedia
principle). So show each thing in its own form rather than describing it. The
table below is a set of ideas, not a must: adapt it to what this user likes and
what the moment needs.

| Instead of describing… | Show |
|---|---|
| A UI change | The running app in an `iframe`, or before/after screenshots in a `gallery` |
| A trend or a comparison | A chart, with the takeaway as its title |
| How parts connect | A diagram (inline SVG in an `html` window) |
| What changed in code | The diff, coloured, grouped by file, in a `diff` window |
| The weather | An icon, the temperature, the next hours as a strip |
| An inbox | One row per email: sender, subject, what it asks of the user |
| A long job | A `progress` window or a live `stream` |
| Options | Cards or a table, in `ideas` or `actions` |

When the content *is* text (a log, an email, a document, something to copy),
showing it as text is right.

## Easy to read

Most people scan a screen rather than read it, taking in about a quarter of its
words (Nielsen Norman Group). For anything that isn't meant to be read through:

- Lead with the answer, the number, or the verdict; details follow.
- Summarise before listing: "4 files, +120 −38", "2 of 12 emails need a reply".
- Prefer a table to a paragraph, a number to a sentence, a label to a caption.
- Keep the first view simple and put depth a click away: `<details>`, tabs, a
  hover with the exact value (Shneiderman: overview first, details on demand).
- Keep labels beside what they label, and things being compared side by side.

A document or explanation the user wants to read stays as prose, with headings
and a comfortable line length.

## Nice to use

- Add interaction when it helps: filter or search a long list, toggle
  before/after, a slider to try a value, hover for details (Victor's explorable
  explanations).
- Spend colour on the one thing that matters, so it stands out.
- Use the skin's CSS variables for colour so it looks right in light and dark.
- Fit the size it opens at (`--span`, `--height`); scrolling to find the point
  means the window is too small or too full.
- Show how fresh live content is ("updated 2 min ago"), and update quietly.
- An empty or loading window says what will appear; an error says what to do.

## Sources

- Nielsen, [10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/).
- Nielsen Norman Group, [How Users Read on the Web](https://www.nngroup.com/articles/how-users-read-on-the-web/),
  [How Little Do Users Read?](https://www.nngroup.com/articles/how-little-do-users-read/),
  and [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/).
- Shneiderman, [The Eyes Have It](https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf) (1996).
- Mayer, *Multimedia Learning*.
- Tufte, *The Visual Display of Quantitative Information*.
- Victor, [Explorable Explanations](http://worrydream.com/ExplorableExplanations/).
- [Laws of UX](https://lawsofux.com/).
