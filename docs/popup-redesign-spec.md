# Popup Redesign — Implementation Spec

Status: design approved, ready to build
Reference mockup: `docs/popup-redesign-mockup.html` (open in a browser; all controls are live)
Scope: the fountain popup only. No map, filter, search, or backend changes.

---

## What's changing and why

The current popup does three jobs at once — rate, edit attributes, report a problem — with
everything at equal weight. A fountain with nothing wrong still shows two paragraphs of rating
copy and three empty checkboxes.

The redesign narrows what the popup asks for, and changes what a rating *means*.

---

## 1. Rating model: behavior, not opinion

Replace thumbs up/down with two labeled actions:

| Action | Meaning |
|---|---|
| `👍 I drank here` | Water was available and I used it |
| `👎 I chose not to` | Water was available and I passed |

**Why:** both report the user's own behavior, which they know for certain, rather than a verdict
on the fountain, which they'd be guessing at. The old thumbs-down invited ratings of the
*surroundings* (dirty area, sketchy park) rather than whether the fountain delivers drinking
water. "I chose not to" can't be wrong, and it stays distinct from a no-water report — choosing
implies water was there.

**Do not add a "why" follow-up.** Reason tags were considered and cut for simplicity.

**One vote per device.** This matches the existing API contract (device UUID in localStorage,
one rating per device per fountain, upsert). Tapping your current choice is a no-op; tapping the
other switches it. Counts move, they never stack. The selected row is color-filled — no
explanatory text needed.

### Summary line

One line directly beneath the two buttons, combining count and recency:

> `13 of 16 people drank here as of 3 days ago`

Count and date are one claim — a tally without a date overstates its own freshness. If there are
no votes yet, show no summary line at all.

### UI Change Only

Existing thumbs data maps directly: up → drank, down → chose not to. No data transformation needed
beyond relabeling in the UI.

---

## 2. States

| State | Pin | Color |
|---|---|---|---|---|
| Unrated | `?` | grey `#a7adb5` |
| Working | `👍` | blue `#2f6fed` |
| No water | `✕` | orange `#df6a30` |
| Not there | `?` | slate `#78828e` |

---

## 3. Layout

Popup width 300px. Left border 6px in the current state's color — this is the passive status
signal, always present.

**Reading order:**

1. Status heading — **only for No water / Not there**. Icon + label + date. Inter 17px/700, colored to match state. (Not display type — it's a status, not a banner.)
2. Rating rows — two full-width rows, icon left, label, count pill right
3. Summary line
4. Divider
5. Amenity pills — tap to toggle, live, no separate edit mode
6. `⚠️ Report an issue` — full-width row, dashed border, muted label, chevron right
7. Source line — small print: `Carkeek Park · Seattle City GIS`, or just `OpenStreetMap`

**Amenities show as toggleable pills, not checkboxes.** All users can edit; there is no read
state.

### State-specific layout

**Unrated / Working** — full layout above, no heading.

**No water** — heading, then a single neutral row `👍 Water's flowing again`, then Report an
issue, then source line. **No rating rows, no amenity pills.** The button is neutral-styled (no
fill) so it doesn't push users toward clearing the report.

*Open question flagged for Zack:* Report an issue is retained here as the only path from
"no water" to "not there" — someone who finds the fixture actually removed needs somewhere to
say so. Remove if unwanted.

**Not there** — heading, then two neutral rows: `? Confirm not there` and `👍 Undo — I found it`.
Nothing else. Not rateable.

---

## 4. Report an issue

Swaps the card contents in place — same popup, no new modal. Back arrow returns without
reporting.

| Option | Icon | Sub-label | Behavior |
|---|---|---|---|
| No water | `✕` | Couldn't get a drink, whatever the reason | Reports immediately |
| Gone or decommissioned | `?` | Fixtures removed, or fountain no longer exists | Expands to confirm step |

The gone/decommissioned path keeps the existing confirmation copy and Confirm/Cancel pair,
inline in the card. It's higher-stakes — it can eventually pull the pin off the map — so it
doesn't submit on first tap.

Each option's icon previews the pin the fountain will become.

---

## 5. Icon vocabulary

Four symbols, used consistently across pins, popup, report menu, and legend:

- `👍` drank / working
- `👎` chose not to
- `✕` no water
- `?` unrated / not there
- `⚠️` report entry point (popup only, not a pin state)

---

## Explicitly out of scope

- Reason/quality tags for "chose not to" — considered, cut
- Fountain titles in the popup
- Any change to filters, search, map pins, or the hamburger modals
- Seasonal inference from historical reports — future, needs a year of data
