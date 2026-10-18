import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { StudyLearner, features, seedObservation, train, type Candidate } from "../src/learning.ts";

const rows = JSON.parse(await readFile(new URL("../data/seed_sessions.json", import.meta.url), "utf8"));
const library: Candidate = { id: "library", label: "Library desk", timestamp: "2026-10-18T15:00:00-07:00", duration_mins: 45,
  location: "library", study_space: "desk", environment: { clutter_score: 2, lighting: "bright", ergonomics: 9 } };
const bed: Candidate = { ...library, id: "bed", label: "Dorm bed", location: "dorm_room", study_space: "bed",
  environment: { clutter_score: 8, lighting: "dim", ergonomics: 2 } };

test("loads all teammate seed sessions and learns their workspace association", () => {
  const { learner } = train(rows);
  expect(learner.count).toBe(40);
  expect(learner.predict(library).predictedProductivity).toBeGreaterThan(learner.predict(bed).predictedProductivity);
  expect(learner.rank([bed, library], { alpha: 0 })[0]!.id).toBe("library");
});

test("cold start is neutral and repeated evidence approaches its observed rating", () => {
  const learner = new StudyLearner();
  expect(learner.predict(library).predictedProductivity).toBe(3);
  for (let i = 0; i < 100; i++) learner.observe({ ...library, id: `s${i}`, user_productivity_rating: 5, user_mood_rating: 1 });
  expect(learner.predict(library).predictedProductivity).toBeGreaterThan(4.9);
  expect(learner.predict(library).predictedMood).toBeLessThan(1.1);
});

test("a new poor rating reduces the prediction and uncertainty for the rated context", () => {
  const { learner } = train(rows);
  const before = learner.predict(library);
  learner.observe({ ...library, id: "feedback", user_productivity_rating: 1, user_mood_rating: 1 });
  const after = learner.predict(library);
  expect(after.predictedProductivity).toBeLessThan(before.predictedProductivity);
  expect(after.predictedMood).toBeLessThan(before.predictedMood);
  expect(after.uncertainty).toBeLessThan(before.uncertainty);
  expect(learner.count).toBe(41);
});

test("productivity and mood priorities can select different plans", () => {
  const learner = new StudyLearner();
  for (let i = 0; i < 30; i++) {
    learner.observe({ ...library, id: `l${i}`, user_productivity_rating: 5, user_mood_rating: 1 });
    learner.observe({ ...bed, id: `b${i}`, user_productivity_rating: 1, user_mood_rating: 5 });
  }
  expect(learner.rank([library, bed], { productivityWeight: 1, alpha: 0 })[0]!.id).toBe("library");
  expect(learner.rank([library, bed], { productivityWeight: 0, alpha: 0 })[0]!.id).toBe("bed");
});

test("outcome ratings never enter the feature vector", () => {
  const observation = seedObservation(rows[0]);
  expect(features(observation)).toEqual(features({ ...observation, user_productivity_rating: 5, user_mood_rating: 5 } as any));
});

test("time changes alone cannot manufacture a learned time preference", () => {
  const { learner } = train(rows);
  expect(learner.predict(library)).toEqual(learner.predict({ ...library, timestamp: "2026-10-18T09:00:00-07:00" }));
});

test("recursive ridge predictions are independent of observation order", () => {
  const observations = rows.map(seedObservation);
  const a = new StudyLearner(), b = new StudyLearner();
  for (const o of observations) a.observe(o);
  for (const o of observations.slice().reverse()) b.observe(o);
  for (const plan of [library, bed]) {
    expect(a.predict(plan).predictedProductivity).toBeCloseTo(b.predict(plan).predictedProductivity, 10);
    expect(a.predict(plan).uncertainty).toBeCloseTo(b.predict(plan).uncertainty, 10);
  }
});

test("duplicate feedback is rejected without changing learned state", () => {
  const learner = new StudyLearner();
  const o = seedObservation(rows[0]);
  learner.observe(o);
  const before = learner.predict(library);
  expect(() => learner.observe(o)).toThrow("already learned");
  expect(learner.predict(library)).toEqual(before);
});

test("invalid and missing values fail instead of silently fabricating features", () => {
  for (const rating of [0, 6, 2.5, NaN, null, "5"]) {
    expect(() => seedObservation({ ...rows[0], user_productivity_rating: rating })).toThrow();
  }
  expect(() => features({ ...library, environment: undefined } as any)).toThrow();
  expect(() => features({ ...library, location: "unknown" } as any)).toThrow();
  expect(() => features({ ...library, timestamp: "2026-10-18T15:00" })).toThrow();
  expect(() => new StudyLearner(0)).toThrow();
  expect(() => new StudyLearner().predict(library, { productivityWeight: 2 })).toThrow();
});

test("normalizes the seed key typo, refuses duplicate candidates, and leaves source data intact", () => {
  const before = JSON.stringify(rows);
  const corrected = { ...rows[0], perceptron_tags: rows[0].peceptron_tags };
  delete corrected.peceptron_tags;
  expect(seedObservation(corrected)).toEqual(seedObservation(rows[0]));
  const { learner } = train(rows);
  expect(() => learner.rank([library, library])).toThrow("unique");
  learner.observe({ ...library, id: "example", user_productivity_rating: 1, user_mood_rating: 2 });
  expect(JSON.stringify(rows)).toBe(before);
});
