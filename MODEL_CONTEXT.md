# How Daywise uses ratings and optional context

Daywise has two different learning and reasoning paths. Keeping them distinct makes it possible to explain why a suggestion was made.

## Numerical reward model

The TypeScript bot fits two weighted linear reward estimates: productivity and mood. Their inputs are 19 pre-session context features describing the place category, setup, environment, duration and missing data. Explicit ratings from linked completed sessions supply the targets. New eligible feedback changes the fitted parameters used in subsequent predictions. The model combines a 70% productivity and 30% mood objective with an uncertainty bonus when ranking candidates.

Distraction is an observed outcome, not a third prediction head. A high-distraction check-in attributed to a session-specific interruption receives weight 0.25; other observations receive weight 1. This is a heuristic that reduces the influence of interruptions on workspace associations. It does not remove confounding or establish causation.

Synthetic starter examples supply a prior. They are not evidence about this person's habits. Hour of day and subject are not encoded, so the model cannot claim that a different hour improves productivity.

## The optional extra-information question

1. The user finishes a session and supplies numerical ratings.
2. An optional note is interpreted into sentiment, social context, an explicit social effect, and supported factors such as noise, fatigue or task difficulty.
3. The user confirms or corrects that interpretation. Unconfirmed suggestions are not used as memory.
4. Confirmed tags are linked to the same feedback and session. Raw note text is not persisted by this module. It still passes through the configured language-model provider for interpretation and ordinary transient conversation handling.
5. The coordinator receives the five latest confirmed notes with their actual ratings. It can use them when reasoning about a future offer or a useful follow-up question. This is retrieval of structured context, not fine-tuning the language model.

For example, “The assignment was unusually hard, but my friends helped” can produce `task_difficulty`, `with_others` and `helpful`. It does not imply that friends were distracting or that the library caused a low rating. A later coordinator decision can take this history into account, but cannot assume those friends or that assignment are present now.

The new summary also supplies descriptive groups with at least three confirmed sessions in the last 90 days. It reports the count and average actual productivity and mood ratings for each factor or social tag. Groups overlap and are not controlled comparisons. Small groups are omitted. These summaries inform reasoning; they do not directly alter LinUCB scores or override scheduling and approval checks.

## Supabase persistence

Run `supabase/014_session_context.sql` after the existing migrations. Then restart the bot with this branch. The existing minute-by-minute feedback sync will upload confirmed tags to `study_session_context`. Failed uploads stay queued locally and retry, including after restart. The feedback ID makes retries idempotent. A composite foreign key ensures that the tags belong to the matching feedback, session and conversation. Anonymous and authenticated browser roles have no table access; only the backend service role can read and insert.

This upgrade backs up confirmed tags. It does not yet restore this context automatically from Supabase on a different laptop or add it to the dashboard API. Local confirmed context remains the coordinator's source. Existing numerical session learning already has a separate cloud-history path.

## Why not replace this with deep reinforcement learning?

A contextual bandit is a simpler member of the reinforcement-learning family: choose an option for the current context and learn from the resulting reward. Full sequential RL would additionally estimate how actions change future states and long-term outcomes. Daywise does not currently have enough real interaction trajectories, a validated long-term reward, or a safe evaluation environment to justify that complexity.

This implementation uses LinUCB rankings as input to a bounded language-model coordinator. The coordinator can decline an offer or choose a permitted option, so the whole system is not a pure LinUCB policy and does not inherit the original algorithm's theoretical guarantees automatically.

The next useful upgrades are versioned decision logs that link candidate contexts, the option actually shown, acceptance and the eventual session outcome; prospective inputs such as starting energy; and evaluation on real held-out sessions against a simple baseline. Optional post-session sentiment must not be used to predict the outcome of that same session, because that leaks outcome information. Fake trajectories cannot establish that a more complex policy improves real users' schedules.

Reference: https://www.microsoft.com/en-us/research/publication/a-contextual-bandit-approach-to-personalized-news-article-recommendation-3/
