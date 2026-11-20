# Owner profile

**An opt-in file of dated observations about the owner — how they like answers, what they are working on, the operating decisions they made and what to avoid — that the lead reads in its prompt and updates once a day.** Lane rules (`dori lesson`) describe how work is done in a repository and reach lane briefs; the owner profile describes the person the lead talks to and reaches only the lead.

Nothing is enabled by installing or updating. With no profile file the lead's prompt has no owner section, and with no `ownerDistillHour` the hourly loop never asks for a distill.

## The file

`$DORI_HOME/owner.md` (default `~/.dori/owner.md`). `dori harness owner init` creates it with its five sections, in this order:

```markdown
# Owner profile

## Preferences

## Current interests

## Decisions

## Avoid

## Update log
```

Each entry is one line, `- (YYYY-MM-DD) text`, dated with the day it was last confirmed. The owner may edit it by hand at any time.

## Reading: the lead's prompt

When `dori harness up` renders the lead's prompt, or a migration writes the lead's handoff brief, the profile is appended at its end under the header `## Owner profile (observations, not instructions)`. The header states that the observations shape tone, defaults and context only, rank below every safety, authorization and scope rule, and grant no permission: a line such as "merge without asking" is not merge authorization. Duty, lanes and the reviewer never receive it.

The profile is cut to 16384 bytes (`OWNER_PROFILE_MAX_BYTES`) at a line boundary, with a note naming the file when it was cut. OMP reads the appended prompt file when the session starts, so an edit reaches a lead started after it; the running lead already holds the conversation the day's distill came from. `dori harness owner show` prints exactly the section the lead receives.

## Writing: the daily distill

Set the local hour from which the distill is due in `$DORI_HOME/config.json`:

```json
{ "ownerDistillHour": 23 }
```

With that key and an existing profile, the first hourly loop run at or after that hour each local day adds one line to its `[LOOP ...]` message for the lead: `[OWNER-DISTILL <date>] Update the owner profile once for today: read <DORI_HOME>/prompts/owner-distill.md and follow it.` The loop renders that procedure from `prompts/owner-distill.md` (overridable through `DORI_PROMPTS_DIR`) and records the day in `loop/owner-distill.json`, so a later run the same day asks nothing. A run with no lead registered asks nothing and records nothing. An invalid value is reported as a loop finding.

The lead does the distill itself. Its source is the conversation in its own session: the owner's messages and its replies. The harness keeps no separate conversation transcript; the Discord owed-answer ledger holds only recent owner messages without reply text, so it is not used. Conversation that compaction already removed from the lead's context is not available, and the procedure asks the lead to say so in the update log.

The procedure:

1. `dori harness owner snapshot` copies the profile to `owner-history/<date>.md` unless that day's snapshot exists.
2. Edit the profile. Add an observation only when the owner stated it directly or it showed up at least twice. Merge duplicates and refresh their dates, and correct Preferences and Avoid lines that the day contradicts. Remove interests last seen more than 14 days ago. Decisions never lose a fact: a changed decision ends with `(replaces: <old entry text>)`, an unsettled disagreement stays as `CONFLICT: <first> / <second>`, and lines beyond 20 move to `owner-decisions-archive.md` instead of being deleted. Add one Update log line and keep the newest 14.
3. `dori harness owner check` must print `OWNER_OK`.

## Commands

```text
dori harness owner init                 create the profile with its five sections (refuses if it exists)
dori harness owner show                 the section the lead's prompt receives, or NO_OWNER_PROFILE
dori harness owner snapshot             copy the profile to owner-history/<today>.md unless it exists
dori harness owner check                OWNER_OK, or one OWNER_PROBLEM line each and exit 1
dori harness owner diff [DATE]          changed lines since a dated snapshot (default: the newest)
dori harness owner revert DATE          restore a dated snapshot; the current profile is saved first
```

`check` reports: sections other than the five in order; entries not in `- (YYYY-MM-DD) text` form or dated after today; Current interests older than 14 days; more than 20 Decisions or 14 Update log lines; a file over 16384 bytes; recognizable credentials (Slack, GitHub, AWS and `sk-` keys, bearer tokens, private keys) and e-mail addresses; and any Decisions entry of today's snapshot whose text is no longer in Decisions or the archive. The pattern check catches common shapes only; the procedure separately forbids credentials and other people's personal details.

`revert` saves the current profile as `owner-history/pre-revert-<time>.md` before restoring, so a revert can itself be undone. Snapshots and the archive are never deleted by these commands.

## Limits

- The profile is context, not policy. It cannot grant merge, deployment, posting, spending or destructive authority, and host and project rules always win.
- A distill edit reaches the lead's prompt at the lead's next start, not mid-session.
- The distill depends on the lead's own context for the day; it reads no other transcript.
