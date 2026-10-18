// Shared linear reward model + LinUCB selection. No LLM or external calls.
export const LOCATIONS = ["home", "dorm_room", "library", "classroom", "cafe"] as const;
export const SPACES = ["chair", "desk", "shared_table", "bed", "beanbag"] as const;
export type Context = {
  timestamp: string;
  duration_mins: number;
  location: typeof LOCATIONS[number];
  study_space: typeof SPACES[number];
  environment: { clutter_score: number; lighting: "dim" | "bright"; ergonomics: number };
};
export type Observation = Context & {
  id: string;
  user_productivity_rating: number;
  user_mood_rating: number;
};
export type Candidate = Context & { id: string; label: string };
export type Policy = { productivityWeight?: number; alpha?: number };
export const FEATURE_NAMES = [
  "bias", ...LOCATIONS.slice(1).map(x => `location:${x}`),
  ...SPACES.slice(1).map(x => `space:${x}`),
  "clutter", "bright_light", "ergonomics", "duration",
];
const dimension = FEATURE_NAMES.length;
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
const multiply = (a: number[][], x: number[]) => a.map(row => dot(row, x));
const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function bounded(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

export function features(context: Context): number[] {
  if (!context || !context.environment) throw new Error("Missing study environment");
  if (!LOCATIONS.includes(context.location)) throw new Error("Unknown location");
  if (!SPACES.includes(context.study_space)) throw new Error("Unknown study space");
  if (typeof context.timestamp !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(context.timestamp)
      || !Number.isFinite(Date.parse(context.timestamp))) throw new Error("Timestamp needs a timezone offset");
  if (!["bright", "dim"].includes(context.environment.lighting)) throw new Error("Unknown lighting");
  const clutter = bounded(context.environment.clutter_score, 1, 10, "clutter_score");
  const ergonomics = bounded(context.environment.ergonomics, 1, 10, "ergonomics");
  const duration = bounded(context.duration_mins, 5, 240, "duration_mins");
  // Hours/subjects are deliberately excluded: this seed generator has no time reward effect or subject field.
  // Bounding boxes and observed outcome ratings are not pre-session predictive features here.
  return [1, ...LOCATIONS.slice(1).map(x => Number(context.location === x)),
    ...SPACES.slice(1).map(x => Number(context.study_space === x)),
    (clutter - 1) / 9, Number(context.environment.lighting === "bright"),
    (ergonomics - 1) / 9, duration / 120];
}

export function seedObservation(row: unknown): Observation {
  if (!row || typeof row !== "object") throw new Error("Invalid session record");
  const r = row as Record<string, any>;
  // Normalize the existing dataset's misspelled key without changing teammate-owned data.
  const tags = r.peceptron_tags ?? r.perceptron_tags;
  const observation: Observation = {
    id: r.id, timestamp: r.timestamp, duration_mins: r.duration_mins,
    location: r.location, study_space: r.study_space,
    environment: tags && { clutter_score: tags.clutter_score, lighting: tags.lighting, ergonomics: tags.ergonomics },
    user_productivity_rating: r.user_productivity_rating, user_mood_rating: r.user_mood_rating,
  };
  validateObservation(observation);
  return observation;
}

function validateObservation(observation: Observation): void {
  features(observation);
  if (typeof observation.id !== "string" || !observation.id.trim()) throw new Error("Session ID is required");
  for (const key of ["user_productivity_rating", "user_mood_rating"] as const) {
    const rating = bounded(observation[key], 1, 5, key);
    if (!Number.isInteger(rating)) throw new Error("Ratings must be whole numbers");
  }
}

export class StudyLearner {
  private inverse: number[][];
  private productivity = Array<number>(dimension).fill(0);
  private mood = Array<number>(dimension).fill(0);
  private ids = new Set<string>();
  get count(): number { return this.ids.size; }

  constructor(lambda = 1) {
    bounded(lambda, 0.000001, 1000000, "lambda");
    this.inverse = Array.from({ length: dimension }, (_, i) =>
      Array.from({ length: dimension }, (_, j) => i === j ? 1 / lambda : 0));
  }

  observe(observation: Observation, sampleWeight = 1): void {
    validateObservation(observation);
    bounded(sampleWeight, 0.000001, 1, "sampleWeight");
    if (this.ids.has(observation.id)) throw new Error(`Session already learned: ${observation.id}`);
    const x = features(observation);
    // Weighted ridge: A <- A + w xxᵀ, b <- b + w xy.
    const v = multiply(this.inverse, x);
    const denominator = 1 + sampleWeight * dot(x, v);
    const next = this.inverse.map((row, i) => row.map((value, j) => value - sampleWeight * v[i]! * v[j]! / denominator));
    // Center ratings at 3, normalize to [-1, 1]. A cold model predicts neutral 3/5.
    const p = (observation.user_productivity_rating - 3) / 2;
    const m = (observation.user_mood_rating - 3) / 2;
    this.productivity = this.productivity.map((value, i) => value + sampleWeight * x[i]! * p);
    this.mood = this.mood.map((value, i) => value + sampleWeight * x[i]! * m);
    this.inverse = next;
    this.ids.add(observation.id);
  }

  predict(context: Context, policy: Policy = {}) {
    const weight = bounded(policy.productivityWeight ?? 0.7, 0, 1, "productivityWeight");
    const alpha = bounded(policy.alpha ?? 0.2, 0, 10, "alpha");
    const x = features(context);
    const rawP = dot(x, multiply(this.inverse, this.productivity));
    const rawM = dot(x, multiply(this.inverse, this.mood));
    const uncertainty = Math.sqrt(Math.max(0, dot(x, multiply(this.inverse, x))));
    const expected = weight * rawP + (1 - weight) * rawM;
    return {
      predictedProductivity: clip(3 + 2 * rawP, 1, 5),
      predictedMood: clip(3 + 2 * rawM, 1, 5),
      predictedUtility: clip(3 + 2 * expected, 1, 5),
      uncertainty,
      explorationBonus: 2 * alpha * uncertainty,
      selectionScore: 3 + 2 * (expected + alpha * uncertainty),
      observations: this.count,
    };
  }

  rank(candidates: Candidate[], policy: Policy = {}) {
    const ids = candidates.map(c => c.id);
    if (ids.some(id => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
      throw new Error("Candidate IDs must be present and unique");
    }
    return candidates.map(candidate => ({ ...candidate, ...this.predict(candidate, policy) }))
      .sort((a, b) => b.selectionScore - a.selectionScore || a.id.localeCompare(b.id));
  }
}

export function train(rows: unknown[]): { learner: StudyLearner; observations: Observation[] } {
  const observations = rows.map(seedObservation).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const learner = new StudyLearner();
  for (const observation of observations) learner.observe(observation);
  return { learner, observations };
}
