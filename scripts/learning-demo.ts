import { readFile } from "node:fs/promises";
import { train, type Candidate } from "../src/learning.ts";

const source = new URL("../data/seed_sessions.json", import.meta.url);
const rows = JSON.parse(await readFile(source, "utf8"));
const { learner, observations } = train(rows);
const timestamp = "2026-10-18T15:00:00-07:00";
// Hypothetical profiles supplied to the model, not current camera observations or booked events.
const candidates: Candidate[] = [
  { id: "library", label: "Library desk — bright, low clutter", timestamp, duration_mins: 45,
    location: "library", study_space: "desk", environment: { clutter_score: 2, lighting: "bright", ergonomics: 9 } },
  { id: "cafe", label: "Cafe shared table — bright, moderate clutter", timestamp, duration_mins: 45,
    location: "cafe", study_space: "shared_table", environment: { clutter_score: 4, lighting: "bright", ergonomics: 5 } },
  { id: "bed", label: "Dorm bed — dim, high clutter", timestamp, duration_mins: 45,
    location: "dorm_room", study_space: "bed", environment: { clutter_score: 8, lighting: "dim", ergonomics: 2 } },
];

console.log(`\nLEARNING DEMO — ${learner.count} synthetic sessions, no calendar or messaging calls.`);
console.log("Hypothetical workspace profiles; calendar feasibility is NOT checked.");
console.log("Policy: 70% productivity + 30% mood; LinUCB alpha = 0.2.");
console.table(learner.rank(candidates).map(c => ({
  plan: c.label, productivity: c.predictedProductivity.toFixed(2), mood: c.predictedMood.toFixed(2),
  expectedUtility: c.predictedUtility.toFixed(2), explorationBonus: c.explorationBonus.toFixed(2),
  selectionScore: c.selectionScore.toFixed(2),
})));
console.log("Predictions are 1–5. Selection score includes an exploration bonus and can exceed 5.");

const cut = Math.floor(observations.length * 0.7);
const historical = rows.slice().sort((a: any, b: any) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
const validation = train(historical.slice(0, cut)).learner;
const test = observations.slice(cut);
const mean = (key: "user_productivity_rating" | "user_mood_rating") =>
  observations.slice(0, cut).reduce((s, r) => s + r[key], 0) / cut;
const average = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
console.log(`\nChronological holdout: ${cut} training, ${test.length} unseen synthetic sessions.`);
console.table([
  { target: "Productivity", modelMAE: average(test.map(s => Math.abs(validation.predict(s).predictedProductivity - s.user_productivity_rating))).toFixed(3),
    meanBaselineMAE: average(test.map(s => Math.abs(mean("user_productivity_rating") - s.user_productivity_rating))).toFixed(3) },
  { target: "Mood", modelMAE: average(test.map(s => Math.abs(validation.predict(s).predictedMood - s.user_mood_rating))).toFixed(3),
    meanBaselineMAE: average(test.map(s => Math.abs(mean("user_mood_rating") - s.user_mood_rating))).toFixed(3) },
]);
console.log("MAE = average rating prediction error; lower is better. This is not policy evaluation or real-user validation.");

const library = candidates[0]!;
const before = learner.predict(library);
learner.observe({ ...library, id: "DEMO_FEEDBACK_NOT_A_REAL_SESSION", user_productivity_rating: 1, user_mood_rating: 2 });
const after = learner.predict(library);
console.log("\nIllustrative update: a SIMULATED library session receives productivity 1 and mood 2.");
console.log(`Library prediction: productivity ${before.predictedProductivity.toFixed(2)} → ${after.predictedProductivity.toFixed(2)}; mood ${before.predictedMood.toFixed(2)} → ${after.predictedMood.toFixed(2)}.`);
console.log("This update is in memory only. Your seed file is unchanged; rerunning starts from the same 40 sessions.");
console.log("No learned time-of-day or subject preference is claimed: this dataset does not support those effects.");
