# Distraction-aware feedback

When distraction is 4 or 5 out of 5, the bot asks for one of three answers:

- `interruption` or `1`: a friend stopped by, an urgent call, or personal worries.
- `setup` or `2`: persistent nearby noise, uncomfortable seating, or another condition of the setup.
- `unsure` or `3`: the user cannot distinguish them. `skip` also records `unsure`.

Low-distraction check-ins end after the three ratings and store a null attribution. New numeric choices replace the old surroundings/phone/other menu. Old word answers remain accepted. Drafts already waiting at the source step display the new menu when the user texts `rate`.

The new nullable `distraction_attribution` field is stored alongside the unchanged productivity, mood and distraction ratings. It describes the user's judgment; it does not establish a cause. The model does not infer a specific interruption from a generic answer, and records do not store personal details about the interruption.

## Learning policy

For high-distraction sessions, an explicit interruption uses sample weight 0.25. Setup and unsure use weight 1. Unsure does not assert that the location caused distraction; its ordinary association still influences the model. These weights are fixed MVP heuristics, not learned probabilities. Both productivity and mood predictors use the same weight, and the entire workspace feature vector is updated. This reduces influence rather than isolating a causal location effect. It does not learn separate quiet/noisy conditions yet.

Older records without the new field retain the existing rule: high distraction attributed to phone or other uses weight 0.25, otherwise 1. No historical records are rewritten or assigned a new cause. New explicit unsure answers override the legacy other rule and use weight 1.

## Setup

Run `supabase/005_distraction_attribution.sql` in the existing Supabase SQL Editor before enabling cloud sync for new records, then restart the bot. This adds one nullable, constrained column without changing existing rows. The migration has not been applied automatically. If the database lacks the column, local saves remain available and cloud writes remain queued for retry after migration.

No credentials change is needed. Tests use synthetic records and mocked cloud requests; no live texts or database changes are made by the tests.
