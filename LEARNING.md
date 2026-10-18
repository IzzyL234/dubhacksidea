# Study learning module

Run from this project folder:

```powershell
bun scripts/learning-demo.ts
bun test tests/learning.test.ts
```

This is a standalone numerical prototype. It does not start Photon, send messages, change Calendar, or call Grok. It is not yet connected to the bot.

## Data

`data/seed_sessions.json` is an unchanged copy of the teammate's 40 synthetic sessions from `IzzyL234/dubhacksidea` at commit `b5216220d68ec1119083a0846011e71f6c7b2f1b`. Source: https://github.com/IzzyL234/dubhacksidea/blob/b5216220d68ec1119083a0846011e71f6c7b2f1b/seed_sessions.json

The adapter accepts the existing `peceptron_tags` spelling and normalizes it to `environment`. It validates required fields and rejects invalid or duplicate feedback. No missing environment measurements are silently filled in.

## Model

Two linear ridge reward predictors learn productivity and mood separately. There are 13 features: intercept, one-hot location and study-space indicators (one reference category each), normalized clutter, bright lighting, ergonomics, and duration. Ratings are centered at 3 and scaled to [-1, 1]. With no observations, the prior predicts 3/5.

Initialize A = lambda I, b_productivity = b_mood = 0, lambda = 1. For each observed session x and centered outcome y, update A <- A + xx^T and b <- b + xy. We maintain A^-1 using Sherman–Morrison. Predictions use theta = A^-1 b. Each new rating updates the numerical model without prompting or retraining an LLM.

The shared-feature LinUCB policy ranks supplied candidate plans by:

`weighted expected reward + alpha * sqrt(x^T A^-1 x)`

Default objective is 70% productivity and 30% mood, configurable through `productivityWeight`. Alpha defaults to 0.2. These are declared design choices, not parameters learned from 40 records. Predictions are displayed on a clipped 1–5 scale; the selection score includes exploration and may exceed 5. The exploration term measures model/design uncertainty, not a calibrated probability or empirical confidence interval. Scores do not establish causal effects of lighting, location, or any other feature.

This implements a contextual-bandit selection policy with a supervised warm start from synthetic history. It is not a trained deep RL system, and no real online learning experiment has occurred. Multiple conditions are correlated in this small dataset; individual feature effects are not reliably identifiable. Bounding boxes are excluded from this small model. Productivity and mood are outcome labels, never pre-session features.

Time of day and subject are deliberately excluded for now. The existing generator does not use time to generate its reward, and it contains no subject. Learning useful time preferences needs a revised simulation with noisy time effects and varied environments across times, or real feedback. More rows from the same generator do not fix this missing relationship.

## Demo and verification

The demo compares three explicitly hypothetical workspace profiles at the same illustrative timestamp and duration. Their environmental values are inputs, not inferred current conditions. No availability, travel feasibility or opening hours are checked. For future Calendar integration, only feasible plans should reach this policy; unknown environmental values must be requested or clearly marked as demo assumptions.

The demo also reports a chronological 28/12 split, comparing rating MAE against a training-mean baseline. Held-out rows do not train that evaluation model. This evaluates prediction on synthetic data only; it is not offline policy evaluation, a regret estimate, or a real-user productivity result. It cannot establish that recommending one action would outperform another for a person.

Finally, one clearly labeled simulated poor library rating updates a separate model trained on all 40 sessions. It prints before/after predictions. This update is in memory only and resets on every run. It is not saved as real user feedback, and the seed file remains unchanged. Durable feedback storage and matching a rating to a confirmed session are the next integration steps.

References:

- LinUCB: https://arxiv.org/abs/1003.0146
- Contextual-bandit feedback: https://vowpalwabbit.org/docs/vowpal_wabbit/python/latest/tutorials/python_Contextual_bandits_and_Vowpal_Wabbit.html

## Sharing this project

Share bot source, learning source, `package.json`, `bun.lock`, tests, and synthetic data through Git. Never include `.env`, `credentials.json`, or `.google-calendar-token.json`. Your teammate must supply their own private credentials and perform Google sign-in locally. No files are pushed by the learning demo.
