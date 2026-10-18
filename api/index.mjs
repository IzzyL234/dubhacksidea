// src/learning.ts
var LOCATIONS = ["home", "dorm_room", "library", "classroom", "cafe"];
var SPACES = ["chair", "desk", "shared_table", "bed", "beanbag"];
var FEATURE_NAMES = [
  "bias",
  ...LOCATIONS.slice(1).map((x) => `location:${x}`),
  ...SPACES.slice(1).map((x) => `space:${x}`),
  "clutter",
  "bright_light",
  "ergonomics",
  "duration",
  "missing:location",
  "missing:study_space",
  "missing:clutter",
  "missing:lighting",
  "missing:ergonomics",
  "missing:duration"
];
var dimension = FEATURE_NAMES.length;

// src/time.ts
var TIMEZONE = "America/Los_Angeles";
function localParts(timestamp) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}
function localDate(timestamp) {
  const p = localParts(timestamp);
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(date, days) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

// src/insights.ts
function insightPeriod(now) {
  return Number(localParts(now).hour) >= 20 ? localDate(now) : addDays(localDate(now), -1);
}
function insightObservations(user, pairs, seed) {
  if (!/^[a-f0-9]{64}$/.test(user))
    throw Error("Invalid owner");
  const out = [], seen = new Set;
  const add = (id, place, p, m, d, a, synthetic) => {
    if (seen.has(id) || ![p, m, d].every((v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5))
      return;
    seen.add(id);
    out.push({ id, place: LOCATIONS.includes(place) ? place : null, productivity: p, mood: m, distraction: d, attribution: ["interruption", "setup", "unsure"].includes(String(a)) ? a : null, synthetic });
  };
  for (const raw of seed) {
    const r = raw;
    if (typeof r?.id === "string")
      add("seed:" + r.id, r.location, r.user_productivity_rating, r.user_mood_rating, r.user_distraction_rating, r.distraction_attribution, true);
  }
  for (const raw of pairs) {
    const s = raw?.session_record, f = raw?.feedback_record;
    if (!s || !f || s.user_id !== user || f.conversation_key !== user || s.is_synthetic !== false || f.is_synthetic !== false || s.status !== "completed" || s.feedback_id !== f.id || f.session_id !== s.id || typeof f.id !== "string")
      continue;
    add("personal:" + f.id, s.location, f.productivity_rating, f.mood_rating, f.distraction_rating, f.distraction_attribution ?? (["phone", "other"].includes(f.distraction_source) ? "interruption" : f.distraction_source === "surroundings" ? "setup" : null), false);
  }
  return out;
}
function buildInsights(observations, now = Date.now()) {
  const places = [...LOCATIONS, "unknown"].flatMap((place) => {
    const rows = observations.filter((r) => (r.place ?? "unknown") === place);
    if (!rows.length)
      return [];
    const average = (key) => Math.round(rows.reduce((sum, r) => sum + r[key], 0) / rows.length * 100) / 100;
    const high = rows.filter((r) => r.distraction >= 4);
    return [{ place, count: rows.length, averageDistraction: average("distraction"), highDistraction: high.length, interruptions: high.filter((r) => r.attribution === "interruption").length, setup: high.filter((r) => r.attribution === "setup").length, unsure: high.filter((r) => r.attribution === null || r.attribution === "unsure").length, productivity: average("productivity"), mood: average("mood") }];
  }).sort((a, b) => b.averageDistraction - a.averageDistraction || a.place.localeCompare(b.place));
  const named = places.filter((p) => p.place !== "unknown" && p.count >= 3), findings = [];
  if (named.length) {
    const most = named[0];
    findings.push(`${most.place.replaceAll("_", " ")} has the highest observed distraction average: ${most.averageDistraction.toFixed(1)}/5 across ${most.count} sessions. This is an association, not proof the place caused distraction.`);
  }
  const high = observations.filter((r) => r.distraction >= 4), interruptions = high.filter((r) => r.attribution === "interruption").length;
  if (high.length)
    findings.push(`${interruptions} of ${high.length} high-distraction check-ins were attributed to interruptions rather than the setup. These observations receive less weight when learning productivity and mood associations.`);
  const unknown = places.find((p) => p.place === "unknown");
  if (unknown)
    findings.push(`${unknown.count} session(s) have no place category. Automatic location matching and the end-of-session fallback question help link future ratings to places.`);
  if (!observations.length)
    findings.push("Complete a study check-in with productivity, mood and distraction ratings to start building insights.");
  return { generatedAt: new Date(now).toISOString(), period: insightPeriod(now), nextRefresh: "Daily at 8 PM Pacific while the bot runs", total: observations.length, personal: observations.filter((r) => !r.synthetic).length, synthetic: observations.filter((r) => r.synthetic).length, places, findings };
}

// data/seed_sessions.json
var seed_sessions_default = [
  {
    id: "sess_001",
    timestamp: "2026-09-27T15:30:00-07:00",
    duration_mins: 25,
    location: "home",
    study_space: "bed",
    location_class: "home_bed",
    peceptron_tags: {
      clutter_score: 8,
      lighting: "dim",
      ergonomics: 3,
      detected_objects: [
        {
          label: "headphones",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.311,
            y_min: 0.136,
            x_max: 0.641,
            y_max: 0.386
          }
        },
        {
          label: "tablet",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.188,
            y_min: 0.375,
            x_max: 0.511,
            y_max: 0.643
          }
        },
        {
          label: "blanket",
          confidence: 0.92,
          bounding_box: {
            x_min: 0.141,
            y_min: 0.51,
            x_max: 0.385,
            y_max: 0.802
          }
        },
        {
          label: "charging_cable",
          confidence: 0.82,
          bounding_box: {
            x_min: 0.429,
            y_min: 0.299,
            x_max: 0.778,
            y_max: 0.451
          }
        },
        {
          label: "water_bottle",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.541,
            y_min: 0.574,
            x_max: 0.696,
            y_max: 0.731
          }
        },
        {
          label: "laptop",
          confidence: 0.96,
          bounding_box: {
            x_min: 0.438,
            y_min: 0.312,
            x_max: 0.695,
            y_max: 0.54
          }
        },
        {
          label: "smartphone",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.41,
            y_min: 0.618,
            x_max: 0.686,
            y_max: 0.764
          }
        },
        {
          label: "snack_wrapper",
          confidence: 0.84,
          bounding_box: {
            x_min: 0.538,
            y_min: 0.523,
            x_max: 0.736,
            y_max: 0.711
          }
        }
      ]
    },
    user_productivity_rating: 2,
    user_mood_rating: 1,
    user_distraction_rating: 4,
    distraction_attribution: "interruption",
    distraction_source: "phone"
  },
  {
    id: "sess_002",
    timestamp: "2026-09-27T11:45:00-07:00",
    duration_mins: 30,
    location: "dorm_room",
    study_space: "bed",
    location_class: "dorm_room_bed",
    peceptron_tags: {
      clutter_score: 8,
      lighting: "dim",
      ergonomics: 3,
      detected_objects: [
        {
          label: "tangled_wires",
          confidence: 0.76,
          bounding_box: {
            x_min: 0.063,
            y_min: 0.611,
            x_max: 0.385,
            y_max: 0.922
          }
        },
        {
          label: "blanket",
          confidence: 0.94,
          bounding_box: {
            x_min: 0.088,
            y_min: 0.583,
            x_max: 0.426,
            y_max: 0.723
          }
        },
        {
          label: "pillow",
          confidence: 0.96,
          bounding_box: {
            x_min: 0.095,
            y_min: 0.518,
            x_max: 0.391,
            y_max: 0.668
          }
        },
        {
          label: "charging_cable",
          confidence: 0.82,
          bounding_box: {
            x_min: 0.407,
            y_min: 0.246,
            x_max: 0.728,
            y_max: 0.463
          }
        },
        {
          label: "water_bottle",
          confidence: 0.84,
          bounding_box: {
            x_min: 0.401,
            y_min: 0.501,
            x_max: 0.567,
            y_max: 0.693
          }
        },
        {
          label: "smartphone",
          confidence: 0.96,
          bounding_box: {
            x_min: 0.472,
            y_min: 0.341,
            x_max: 0.711,
            y_max: 0.489
          }
        },
        {
          label: "headphones",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.27,
            y_min: 0.424,
            x_max: 0.443,
            y_max: 0.595
          }
        },
        {
          label: "laptop",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.46,
            y_min: 0.226,
            x_max: 0.788,
            y_max: 0.544
          }
        },
        {
          label: "tablet",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.205,
            y_min: 0.468,
            x_max: 0.374,
            y_max: 0.618
          }
        }
      ]
    },
    user_productivity_rating: 2,
    user_mood_rating: 2,
    user_distraction_rating: 2,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_003",
    timestamp: "2026-09-28T20:45:00-07:00",
    duration_mins: 30,
    location: "dorm_room",
    study_space: "beanbag",
    location_class: "dorm_room_beanbag",
    peceptron_tags: {
      clutter_score: 8,
      lighting: "dim",
      ergonomics: 3,
      detected_objects: [
        {
          label: "slippers",
          confidence: 0.84,
          bounding_box: {
            x_min: 0.121,
            y_min: 0.205,
            x_max: 0.364,
            y_max: 0.357
          }
        },
        {
          label: "laptop",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.351,
            y_min: 0.581,
            x_max: 0.488,
            y_max: 0.887
          }
        },
        {
          label: "energy_drink_can",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.114,
            y_min: 0.459,
            x_max: 0.358,
            y_max: 0.582
          }
        },
        {
          label: "tablet",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.54,
            y_min: 0.23,
            x_max: 0.753,
            y_max: 0.461
          }
        },
        {
          label: "charging_cable",
          confidence: 0.83,
          bounding_box: {
            x_min: 0.637,
            y_min: 0.191,
            x_max: 0.757,
            y_max: 0.401
          }
        },
        {
          label: "snack_wrapper",
          confidence: 0.87,
          bounding_box: {
            x_min: 0.56,
            y_min: 0.257,
            x_max: 0.84,
            y_max: 0.545
          }
        },
        {
          label: "smartphone",
          confidence: 0.93,
          bounding_box: {
            x_min: 0.48,
            y_min: 0.368,
            x_max: 0.644,
            y_max: 0.538
          }
        },
        {
          label: "throw_pillow",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.528,
            y_min: 0.134,
            x_max: 0.72,
            y_max: 0.266
          }
        }
      ]
    },
    user_productivity_rating: 1,
    user_mood_rating: 1,
    user_distraction_rating: 4,
    distraction_attribution: "unsure",
    distraction_source: "other"
  },
  {
    id: "sess_004",
    timestamp: "2026-09-28T17:15:00-07:00",
    duration_mins: 35,
    location: "cafe",
    study_space: "chair",
    location_class: "cafe_chair",
    peceptron_tags: {
      clutter_score: 3,
      lighting: "bright",
      ergonomics: 4,
      detected_objects: [
        {
          label: "backpack",
          confidence: 0.87,
          bounding_box: {
            x_min: 0.436,
            y_min: 0.441,
            x_max: 0.652,
            y_max: 0.695
          }
        },
        {
          label: "laptop",
          confidence: 0.94,
          bounding_box: {
            x_min: 0.658,
            y_min: 0.212,
            x_max: 0.943,
            y_max: 0.387
          }
        },
        {
          label: "smartphone",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.487,
            y_min: 0.265,
            x_max: 0.68,
            y_max: 0.558
          }
        }
      ]
    },
    user_productivity_rating: 3,
    user_mood_rating: 2,
    user_distraction_rating: 5,
    distraction_attribution: "interruption",
    distraction_source: "phone"
  },
  {
    id: "sess_005",
    timestamp: "2026-09-28T10:00:00-07:00",
    duration_mins: 45,
    location: "library",
    study_space: "shared_table",
    location_class: "library_shared_table",
    peceptron_tags: {
      clutter_score: 3,
      lighting: "bright",
      ergonomics: 6,
      detected_objects: [
        {
          label: "textbook",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.592,
            y_min: 0.487,
            x_max: 0.853,
            y_max: 0.834
          }
        },
        {
          label: "ballpoint_pen",
          confidence: 0.88,
          bounding_box: {
            x_min: 0.055,
            y_min: 0.549,
            x_max: 0.244,
            y_max: 0.822
          }
        },
        {
          label: "backpack",
          confidence: 0.95,
          bounding_box: {
            x_min: 0.137,
            y_min: 0.163,
            x_max: 0.282,
            y_max: 0.41
          }
        },
        {
          label: "spiral_notebook",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.443,
            y_min: 0.495,
            x_max: 0.61,
            y_max: 0.761
          }
        }
      ]
    },
    user_productivity_rating: 4,
    user_mood_rating: 3,
    user_distraction_rating: 5,
    distraction_attribution: "interruption",
    distraction_source: "phone"
  },
  {
    id: "sess_006",
    timestamp: "2026-09-29T14:45:00-07:00",
    duration_mins: 90,
    location: "library",
    study_space: "shared_table",
    location_class: "library_shared_table",
    peceptron_tags: {
      clutter_score: 1,
      lighting: "bright",
      ergonomics: 6,
      detected_objects: [
        {
          label: "highlighter",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.328,
            y_min: 0.105,
            x_max: 0.465,
            y_max: 0.428
          }
        },
        {
          label: "spiral_notebook",
          confidence: 0.96,
          bounding_box: {
            x_min: 0.405,
            y_min: 0.559,
            x_max: 0.659,
            y_max: 0.713
          }
        },
        {
          label: "noise_cancelling_headphones",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.25,
            y_min: 0.594,
            x_max: 0.553,
            y_max: 0.912
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 3,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_007",
    timestamp: "2026-09-29T15:15:00-07:00",
    duration_mins: 60,
    location: "classroom",
    study_space: "chair",
    location_class: "classroom_chair",
    peceptron_tags: {
      clutter_score: 3,
      lighting: "bright",
      ergonomics: 6,
      detected_objects: [
        {
          label: "smartphone",
          confidence: 0.94,
          bounding_box: {
            x_min: 0.685,
            y_min: 0.546,
            x_max: 1,
            y_max: 0.672
          }
        },
        {
          label: "water_bottle",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.266,
            y_min: 0.612,
            x_max: 0.571,
            y_max: 0.931
          }
        },
        {
          label: "notebook",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.223,
            y_min: 0.533,
            x_max: 0.368,
            y_max: 0.854
          }
        },
        {
          label: "pencil_case",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.195,
            y_min: 0.549,
            x_max: 0.421,
            y_max: 0.739
          }
        }
      ]
    },
    user_productivity_rating: 4,
    user_mood_rating: 3,
    user_distraction_rating: 5,
    distraction_attribution: "interruption",
    distraction_source: "phone"
  },
  {
    id: "sess_008",
    timestamp: "2026-09-30T13:15:00-07:00",
    duration_mins: 45,
    location: "dorm_room",
    study_space: "beanbag",
    location_class: "dorm_room_beanbag",
    peceptron_tags: {
      clutter_score: 6,
      lighting: "dim",
      ergonomics: 3,
      detected_objects: [
        {
          label: "charging_cable",
          confidence: 0.76,
          bounding_box: {
            x_min: 0.681,
            y_min: 0.198,
            x_max: 1,
            y_max: 0.379
          }
        },
        {
          label: "tablet",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.332,
            y_min: 0.501,
            x_max: 0.524,
            y_max: 0.76
          }
        },
        {
          label: "energy_drink_can",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.3,
            y_min: 0.417,
            x_max: 0.479,
            y_max: 0.7
          }
        },
        {
          label: "snack_wrapper",
          confidence: 0.79,
          bounding_box: {
            x_min: 0.652,
            y_min: 0.396,
            x_max: 0.937,
            y_max: 0.687
          }
        },
        {
          label: "throw_pillow",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.287,
            y_min: 0.138,
            x_max: 0.56,
            y_max: 0.334
          }
        },
        {
          label: "laptop",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.601,
            y_min: 0.496,
            x_max: 0.79,
            y_max: 0.687
          }
        }
      ]
    },
    user_productivity_rating: 2,
    user_mood_rating: 1,
    user_distraction_rating: 3,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_009",
    timestamp: "2026-10-01T16:30:00-07:00",
    duration_mins: 30,
    location: "dorm_room",
    study_space: "bed",
    location_class: "dorm_room_bed",
    peceptron_tags: {
      clutter_score: 8,
      lighting: "dim",
      ergonomics: 3,
      detected_objects: [
        {
          label: "tangled_wires",
          confidence: 0.76,
          bounding_box: {
            x_min: 0.329,
            y_min: 0.419,
            x_max: 0.6,
            y_max: 0.646
          }
        },
        {
          label: "clothing_pile",
          confidence: 0.83,
          bounding_box: {
            x_min: 0.189,
            y_min: 0.36,
            x_max: 0.516,
            y_max: 0.663
          }
        },
        {
          label: "headphones",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.105,
            y_min: 0.383,
            x_max: 0.371,
            y_max: 0.58
          }
        },
        {
          label: "water_bottle",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.538,
            y_min: 0.47,
            x_max: 0.71,
            y_max: 0.636
          }
        },
        {
          label: "tablet",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.209,
            y_min: 0.361,
            x_max: 0.524,
            y_max: 0.498
          }
        },
        {
          label: "laptop",
          confidence: 0.94,
          bounding_box: {
            x_min: 0.459,
            y_min: 0.207,
            x_max: 0.739,
            y_max: 0.441
          }
        },
        {
          label: "pillow",
          confidence: 0.94,
          bounding_box: {
            x_min: 0.476,
            y_min: 0.103,
            x_max: 0.769,
            y_max: 0.4
          }
        }
      ]
    },
    user_productivity_rating: 1,
    user_mood_rating: 2,
    user_distraction_rating: 2,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_010",
    timestamp: "2026-10-02T10:45:00-07:00",
    duration_mins: 45,
    location: "cafe",
    study_space: "shared_table",
    location_class: "cafe_shared_table",
    peceptron_tags: {
      clutter_score: 6,
      lighting: "bright",
      ergonomics: 4,
      detected_objects: [
        {
          label: "noise_cancelling_headphones",
          confidence: 0.95,
          bounding_box: {
            x_min: 0.518,
            y_min: 0.378,
            x_max: 0.829,
            y_max: 0.624
          }
        },
        {
          label: "study_guide",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.533,
            y_min: 0.361,
            x_max: 0.713,
            y_max: 0.538
          }
        },
        {
          label: "backpack",
          confidence: 0.93,
          bounding_box: {
            x_min: 0.548,
            y_min: 0.387,
            x_max: 0.812,
            y_max: 0.57
          }
        },
        {
          label: "insulated_tumbler",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.236,
            y_min: 0.249,
            x_max: 0.43,
            y_max: 0.493
          }
        },
        {
          label: "ballpoint_pen",
          confidence: 0.83,
          bounding_box: {
            x_min: 0.2,
            y_min: 0.482,
            x_max: 0.482,
            y_max: 0.617
          }
        }
      ]
    },
    user_productivity_rating: 4,
    user_mood_rating: 3,
    user_distraction_rating: 5,
    distraction_attribution: "setup",
    distraction_source: "surroundings"
  },
  {
    id: "sess_011",
    timestamp: "2026-10-02T16:30:00-07:00",
    duration_mins: 50,
    location: "library",
    study_space: "shared_table",
    location_class: "library_shared_table",
    peceptron_tags: {
      clutter_score: 2,
      lighting: "bright",
      ergonomics: 6,
      detected_objects: [
        {
          label: "laptop",
          confidence: 0.99,
          bounding_box: {
            x_min: 0.244,
            y_min: 0.314,
            x_max: 0.569,
            y_max: 0.626
          }
        },
        {
          label: "insulated_tumbler",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.528,
            y_min: 0.54,
            x_max: 0.854,
            y_max: 0.772
          }
        },
        {
          label: "noise_cancelling_headphones",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.366,
            y_min: 0.314,
            x_max: 0.64,
            y_max: 0.618
          }
        },
        {
          label: "desk_divider",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.596,
            y_min: 0.606,
            x_max: 0.942,
            y_max: 0.849
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 2,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_012",
    timestamp: "2026-10-03T16:00:00-07:00",
    duration_mins: 90,
    location: "classroom",
    study_space: "desk",
    location_class: "classroom_desk",
    peceptron_tags: {
      clutter_score: 2,
      lighting: "bright",
      ergonomics: 8,
      detected_objects: [
        {
          label: "pen",
          confidence: 0.83,
          bounding_box: {
            x_min: 0.668,
            y_min: 0.332,
            x_max: 0.98,
            y_max: 0.56
          }
        },
        {
          label: "paper_stack",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.084,
            y_min: 0.624,
            x_max: 0.256,
            y_max: 0.76
          }
        },
        {
          label: "desk_lamp",
          confidence: 0.96,
          bounding_box: {
            x_min: 0.076,
            y_min: 0.117,
            x_max: 0.253,
            y_max: 0.43
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 4,
    distraction_attribution: "interruption",
    distraction_source: "phone"
  },
  {
    id: "sess_013",
    timestamp: "2026-10-03T20:15:00-07:00",
    duration_mins: 120,
    location: "library",
    study_space: "shared_table",
    location_class: "library_shared_table",
    peceptron_tags: {
      clutter_score: 2,
      lighting: "bright",
      ergonomics: 6,
      detected_objects: [
        {
          label: "spiral_notebook",
          confidence: 0.97,
          bounding_box: {
            x_min: 0.12,
            y_min: 0.114,
            x_max: 0.312,
            y_max: 0.39
          }
        },
        {
          label: "textbook",
          confidence: 0.99,
          bounding_box: {
            x_min: 0.308,
            y_min: 0.493,
            x_max: 0.445,
            y_max: 0.772
          }
        },
        {
          label: "desk_divider",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.116,
            y_min: 0.525,
            x_max: 0.432,
            y_max: 0.783
          }
        }
      ]
    },
    user_productivity_rating: 4,
    user_mood_rating: 3,
    user_distraction_rating: 1,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_014",
    timestamp: "2026-10-03T10:00:00-07:00",
    duration_mins: 45,
    location: "library",
    study_space: "desk",
    location_class: "library_desk",
    peceptron_tags: {
      clutter_score: 2,
      lighting: "bright",
      ergonomics: 9,
      detected_objects: [
        {
          label: "external_monitor",
          confidence: 0.97,
          bounding_box: {
            x_min: 0.589,
            y_min: 0.489,
            x_max: 0.809,
            y_max: 0.778
          }
        },
        {
          label: "desk_lamp",
          confidence: 0.96,
          bounding_box: {
            x_min: 0.226,
            y_min: 0.545,
            x_max: 0.47,
            y_max: 0.776
          }
        },
        {
          label: "pen",
          confidence: 0.84,
          bounding_box: {
            x_min: 0.525,
            y_min: 0.248,
            x_max: 0.841,
            y_max: 0.559
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 2,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_015",
    timestamp: "2026-10-03T10:30:00-07:00",
    duration_mins: 120,
    location: "library",
    study_space: "desk",
    location_class: "library_desk",
    peceptron_tags: {
      clutter_score: 1,
      lighting: "bright",
      ergonomics: 10,
      detected_objects: [
        {
          label: "mechanical_keyboard",
          confidence: 0.92,
          bounding_box: {
            x_min: 0.218,
            y_min: 0.254,
            x_max: 0.475,
            y_max: 0.576
          }
        },
        {
          label: "coffee_mug",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.386,
            y_min: 0.205,
            x_max: 0.562,
            y_max: 0.418
          }
        },
        {
          label: "mouse",
          confidence: 0.93,
          bounding_box: {
            x_min: 0.206,
            y_min: 0.362,
            x_max: 0.49,
            y_max: 0.585
          }
        }
      ]
    },
    user_productivity_rating: 4,
    user_mood_rating: 4,
    user_distraction_rating: 4,
    distraction_attribution: "interruption",
    distraction_source: "phone"
  },
  {
    id: "sess_016",
    timestamp: "2026-10-05T09:00:00-07:00",
    duration_mins: 45,
    location: "cafe",
    study_space: "shared_table",
    location_class: "cafe_shared_table",
    peceptron_tags: {
      clutter_score: 6,
      lighting: "bright",
      ergonomics: 6,
      detected_objects: [
        {
          label: "study_guide",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.507,
            y_min: 0.249,
            x_max: 0.685,
            y_max: 0.397
          }
        },
        {
          label: "desk_divider",
          confidence: 0.81,
          bounding_box: {
            x_min: 0.128,
            y_min: 0.395,
            x_max: 0.423,
            y_max: 0.558
          }
        },
        {
          label: "backpack",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.365,
            y_min: 0.499,
            x_max: 0.71,
            y_max: 0.74
          }
        },
        {
          label: "ballpoint_pen",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.115,
            y_min: 0.207,
            x_max: 0.287,
            y_max: 0.368
          }
        },
        {
          label: "noise_cancelling_headphones",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.397,
            y_min: 0.251,
            x_max: 0.741,
            y_max: 0.498
          }
        },
        {
          label: "highlighter",
          confidence: 0.87,
          bounding_box: {
            x_min: 0.132,
            y_min: 0.578,
            x_max: 0.365,
            y_max: 0.899
          }
        }
      ]
    },
    user_productivity_rating: 4,
    user_mood_rating: 4,
    user_distraction_rating: 3,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_017",
    timestamp: "2026-10-05T20:30:00-07:00",
    duration_mins: 45,
    location: "cafe",
    study_space: "chair",
    location_class: "cafe_chair",
    peceptron_tags: {
      clutter_score: 6,
      lighting: "bright",
      ergonomics: 5,
      detected_objects: [
        {
          label: "laptop",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.577,
            y_min: 0.622,
            x_max: 0.717,
            y_max: 0.799
          }
        },
        {
          label: "pencil_case",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.321,
            y_min: 0.428,
            x_max: 0.583,
            y_max: 0.726
          }
        },
        {
          label: "backpack",
          confidence: 0.88,
          bounding_box: {
            x_min: 0.641,
            y_min: 0.264,
            x_max: 0.896,
            y_max: 0.483
          }
        },
        {
          label: "smartphone",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.089,
            y_min: 0.628,
            x_max: 0.232,
            y_max: 0.923
          }
        },
        {
          label: "water_bottle",
          confidence: 0.88,
          bounding_box: {
            x_min: 0.222,
            y_min: 0.145,
            x_max: 0.397,
            y_max: 0.392
          }
        },
        {
          label: "ballpoint_pen",
          confidence: 0.8,
          bounding_box: {
            x_min: 0.316,
            y_min: 0.479,
            x_max: 0.544,
            y_max: 0.607
          }
        }
      ]
    },
    user_productivity_rating: 3,
    user_mood_rating: 3,
    user_distraction_rating: 1,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_018",
    timestamp: "2026-10-05T14:30:00-07:00",
    duration_mins: 50,
    location: "classroom",
    study_space: "desk",
    location_class: "classroom_desk",
    peceptron_tags: {
      clutter_score: 2,
      lighting: "bright",
      ergonomics: 7,
      detected_objects: [
        {
          label: "mouse",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.147,
            y_min: 0.246,
            x_max: 0.3,
            y_max: 0.38
          }
        },
        {
          label: "desk_lamp",
          confidence: 0.94,
          bounding_box: {
            x_min: 0.437,
            y_min: 0.553,
            x_max: 0.769,
            y_max: 0.774
          }
        },
        {
          label: "external_monitor",
          confidence: 0.95,
          bounding_box: {
            x_min: 0.248,
            y_min: 0.321,
            x_max: 0.431,
            y_max: 0.565
          }
        },
        {
          label: "water_bottle",
          confidence: 0.88,
          bounding_box: {
            x_min: 0.439,
            y_min: 0.589,
            x_max: 0.728,
            y_max: 0.848
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 2,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_019",
    timestamp: "2026-10-05T09:00:00-07:00",
    duration_mins: 60,
    location: "library",
    study_space: "desk",
    location_class: "library_desk",
    peceptron_tags: {
      clutter_score: 3,
      lighting: "bright",
      ergonomics: 7,
      detected_objects: [
        {
          label: "highlighter",
          confidence: 0.83,
          bounding_box: {
            x_min: 0.37,
            y_min: 0.15,
            x_max: 0.57,
            y_max: 0.347
          }
        },
        {
          label: "coffee_mug",
          confidence: 0.92,
          bounding_box: {
            x_min: 0.608,
            y_min: 0.281,
            x_max: 0.888,
            y_max: 0.467
          }
        },
        {
          label: "notebook",
          confidence: 0.94,
          bounding_box: {
            x_min: 0.579,
            y_min: 0.403,
            x_max: 0.804,
            y_max: 0.595
          }
        },
        {
          label: "mechanical_keyboard",
          confidence: 0.92,
          bounding_box: {
            x_min: 0.681,
            y_min: 0.322,
            x_max: 0.919,
            y_max: 0.669
          }
        },
        {
          label: "desk_lamp",
          confidence: 0.93,
          bounding_box: {
            x_min: 0.403,
            y_min: 0.327,
            x_max: 0.566,
            y_max: 0.53
          }
        }
      ]
    },
    user_productivity_rating: 4,
    user_mood_rating: 3,
    user_distraction_rating: 4,
    distraction_attribution: "interruption",
    distraction_source: "phone"
  },
  {
    id: "sess_020",
    timestamp: "2026-10-05T17:45:00-07:00",
    duration_mins: 120,
    location: "library",
    study_space: "shared_table",
    location_class: "library_shared_table",
    peceptron_tags: {
      clutter_score: 1,
      lighting: "bright",
      ergonomics: 8,
      detected_objects: [
        {
          label: "textbook",
          confidence: 0.96,
          bounding_box: {
            x_min: 0.252,
            y_min: 0.108,
            x_max: 0.466,
            y_max: 0.28
          }
        },
        {
          label: "laptop",
          confidence: 0.99,
          bounding_box: {
            x_min: 0.124,
            y_min: 0.621,
            x_max: 0.393,
            y_max: 0.776
          }
        },
        {
          label: "ballpoint_pen",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.24,
            y_min: 0.488,
            x_max: 0.456,
            y_max: 0.719
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 3,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_021",
    timestamp: "2026-10-05T17:15:00-07:00",
    duration_mins: 50,
    location: "library",
    study_space: "shared_table",
    location_class: "library_shared_table",
    peceptron_tags: {
      clutter_score: 1,
      lighting: "bright",
      ergonomics: 9,
      detected_objects: [
        {
          label: "highlighter",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.38,
            y_min: 0.551,
            x_max: 0.565,
            y_max: 0.74
          }
        },
        {
          label: "insulated_tumbler",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.699,
            y_min: 0.369,
            x_max: 0.853,
            y_max: 0.613
          }
        },
        {
          label: "backpack",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.409,
            y_min: 0.399,
            x_max: 0.634,
            y_max: 0.593
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 3,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_022",
    timestamp: "2026-10-07T13:15:00-07:00",
    duration_mins: 45,
    location: "classroom",
    study_space: "chair",
    location_class: "classroom_chair",
    peceptron_tags: {
      clutter_score: 1,
      lighting: "bright",
      ergonomics: 9,
      detected_objects: [
        {
          label: "backpack",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.074,
            y_min: 0.376,
            x_max: 0.33,
            y_max: 0.696
          }
        },
        {
          label: "water_bottle",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.336,
            y_min: 0.389,
            x_max: 0.561,
            y_max: 0.675
          }
        },
        {
          label: "notebook",
          confidence: 0.87,
          bounding_box: {
            x_min: 0.476,
            y_min: 0.185,
            x_max: 0.704,
            y_max: 0.528
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 5,
    user_distraction_rating: 1,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_023",
    timestamp: "2026-10-07T15:45:00-07:00",
    duration_mins: 50,
    location: "home",
    study_space: "desk",
    location_class: "home_desk",
    peceptron_tags: {
      clutter_score: 3,
      lighting: "bright",
      ergonomics: 9,
      detected_objects: [
        {
          label: "laptop",
          confidence: 0.99,
          bounding_box: {
            x_min: 0.535,
            y_min: 0.339,
            x_max: 0.678,
            y_max: 0.605
          }
        },
        {
          label: "sticky_notes",
          confidence: 0.87,
          bounding_box: {
            x_min: 0.338,
            y_min: 0.482,
            x_max: 0.666,
            y_max: 0.613
          }
        },
        {
          label: "external_monitor",
          confidence: 0.98,
          bounding_box: {
            x_min: 0.241,
            y_min: 0.306,
            x_max: 0.394,
            y_max: 0.548
          }
        },
        {
          label: "mouse",
          confidence: 0.93,
          bounding_box: {
            x_min: 0.565,
            y_min: 0.193,
            x_max: 0.703,
            y_max: 0.513
          }
        },
        {
          label: "notebook",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.207,
            y_min: 0.602,
            x_max: 0.36,
            y_max: 0.828
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 2,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_024",
    timestamp: "2026-10-09T14:45:00-07:00",
    duration_mins: 60,
    location: "classroom",
    study_space: "desk",
    location_class: "classroom_desk",
    peceptron_tags: {
      clutter_score: 1,
      lighting: "bright",
      ergonomics: 10,
      detected_objects: [
        {
          label: "sticky_notes",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.347,
            y_min: 0.266,
            x_max: 0.697,
            y_max: 0.582
          }
        },
        {
          label: "notebook",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.298,
            y_min: 0.297,
            x_max: 0.486,
            y_max: 0.578
          }
        },
        {
          label: "desk_lamp",
          confidence: 0.87,
          bounding_box: {
            x_min: 0.59,
            y_min: 0.318,
            x_max: 0.712,
            y_max: 0.637
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 4,
    distraction_attribution: "setup",
    distraction_source: "surroundings"
  },
  {
    id: "sess_025",
    timestamp: "2026-10-10T22:00:00-07:00",
    duration_mins: 60,
    location: "library",
    study_space: "desk",
    location_class: "library_desk",
    peceptron_tags: {
      clutter_score: 3,
      lighting: "bright",
      ergonomics: 10,
      detected_objects: [
        {
          label: "highlighter",
          confidence: 0.79,
          bounding_box: {
            x_min: 0.541,
            y_min: 0.522,
            x_max: 0.818,
            y_max: 0.673
          }
        },
        {
          label: "mouse",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.458,
            y_min: 0.122,
            x_max: 0.759,
            y_max: 0.25
          }
        },
        {
          label: "sticky_notes",
          confidence: 0.82,
          bounding_box: {
            x_min: 0.135,
            y_min: 0.6,
            x_max: 0.33,
            y_max: 0.816
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 5,
    distraction_attribution: "interruption",
    distraction_source: "phone"
  },
  {
    id: "sess_026",
    timestamp: "2026-10-10T13:15:00-07:00",
    duration_mins: 50,
    location: "library",
    study_space: "desk",
    location_class: "library_desk",
    peceptron_tags: {
      clutter_score: 2,
      lighting: "bright",
      ergonomics: 9,
      detected_objects: [
        {
          label: "paper_stack",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.099,
            y_min: 0.515,
            x_max: 0.271,
            y_max: 0.791
          }
        },
        {
          label: "pen",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.308,
            y_min: 0.565,
            x_max: 0.556,
            y_max: 0.706
          }
        },
        {
          label: "external_monitor",
          confidence: 0.95,
          bounding_box: {
            x_min: 0.222,
            y_min: 0.168,
            x_max: 0.427,
            y_max: 0.46
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 5,
    user_distraction_rating: 4,
    distraction_attribution: "interruption",
    distraction_source: "phone"
  },
  {
    id: "sess_027",
    timestamp: "2026-10-11T14:45:00-07:00",
    duration_mins: 45,
    location: "home",
    study_space: "desk",
    location_class: "home_desk",
    peceptron_tags: {
      clutter_score: 6,
      lighting: "dim",
      ergonomics: 6,
      detected_objects: [
        {
          label: "pen",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.126,
            y_min: 0.125,
            x_max: 0.255,
            y_max: 0.474
          }
        },
        {
          label: "sticky_notes",
          confidence: 0.8,
          bounding_box: {
            x_min: 0.203,
            y_min: 0.396,
            x_max: 0.412,
            y_max: 0.601
          }
        },
        {
          label: "mouse",
          confidence: 0.97,
          bounding_box: {
            x_min: 0.503,
            y_min: 0.397,
            x_max: 0.758,
            y_max: 0.684
          }
        },
        {
          label: "external_monitor",
          confidence: 0.99,
          bounding_box: {
            x_min: 0.476,
            y_min: 0.559,
            x_max: 0.738,
            y_max: 0.895
          }
        },
        {
          label: "coffee_mug",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.499,
            y_min: 0.219,
            x_max: 0.721,
            y_max: 0.393
          }
        },
        {
          label: "paper_stack",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.688,
            y_min: 0.302,
            x_max: 1,
            y_max: 0.57
          }
        },
        {
          label: "mechanical_keyboard",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.229,
            y_min: 0.633,
            x_max: 0.567,
            y_max: 0.943
          }
        }
      ]
    },
    user_productivity_rating: 2,
    user_mood_rating: 1,
    user_distraction_rating: 4,
    distraction_attribution: "interruption",
    distraction_source: "phone"
  },
  {
    id: "sess_028",
    timestamp: "2026-10-11T10:15:00-07:00",
    duration_mins: 60,
    location: "cafe",
    study_space: "shared_table",
    location_class: "cafe_shared_table",
    peceptron_tags: {
      clutter_score: 3,
      lighting: "bright",
      ergonomics: 4,
      detected_objects: [
        {
          label: "study_guide",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.201,
            y_min: 0.526,
            x_max: 0.502,
            y_max: 0.783
          }
        },
        {
          label: "ballpoint_pen",
          confidence: 0.84,
          bounding_box: {
            x_min: 0.69,
            y_min: 0.643,
            x_max: 0.934,
            y_max: 0.947
          }
        },
        {
          label: "desk_divider",
          confidence: 0.8,
          bounding_box: {
            x_min: 0.613,
            y_min: 0.172,
            x_max: 0.815,
            y_max: 0.473
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 1,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_029",
    timestamp: "2026-10-11T20:30:00-07:00",
    duration_mins: 30,
    location: "dorm_room",
    study_space: "bed",
    location_class: "dorm_room_bed",
    peceptron_tags: {
      clutter_score: 8,
      lighting: "dim",
      ergonomics: 1,
      detected_objects: [
        {
          label: "tablet",
          confidence: 0.92,
          bounding_box: {
            x_min: 0.641,
            y_min: 0.462,
            x_max: 0.83,
            y_max: 0.73
          }
        },
        {
          label: "tangled_wires",
          confidence: 0.73,
          bounding_box: {
            x_min: 0.699,
            y_min: 0.566,
            x_max: 0.917,
            y_max: 0.711
          }
        },
        {
          label: "smartphone",
          confidence: 0.93,
          bounding_box: {
            x_min: 0.338,
            y_min: 0.595,
            x_max: 0.532,
            y_max: 0.749
          }
        },
        {
          label: "snack_wrapper",
          confidence: 0.77,
          bounding_box: {
            x_min: 0.456,
            y_min: 0.422,
            x_max: 0.74,
            y_max: 0.63
          }
        },
        {
          label: "headphones",
          confidence: 0.88,
          bounding_box: {
            x_min: 0.242,
            y_min: 0.378,
            x_max: 0.461,
            y_max: 0.68
          }
        },
        {
          label: "clothing_pile",
          confidence: 0.8,
          bounding_box: {
            x_min: 0.476,
            y_min: 0.583,
            x_max: 0.723,
            y_max: 0.902
          }
        },
        {
          label: "water_bottle",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.627,
            y_min: 0.328,
            x_max: 0.937,
            y_max: 0.54
          }
        },
        {
          label: "laptop",
          confidence: 0.97,
          bounding_box: {
            x_min: 0.253,
            y_min: 0.272,
            x_max: 0.432,
            y_max: 0.611
          }
        }
      ]
    },
    user_productivity_rating: 2,
    user_mood_rating: 1,
    user_distraction_rating: 4,
    distraction_attribution: "unsure",
    distraction_source: "other"
  },
  {
    id: "sess_030",
    timestamp: "2026-10-12T21:45:00-07:00",
    duration_mins: 50,
    location: "dorm_room",
    study_space: "bed",
    location_class: "dorm_room_bed",
    peceptron_tags: {
      clutter_score: 6,
      lighting: "dim",
      ergonomics: 1,
      detected_objects: [
        {
          label: "tablet",
          confidence: 0.93,
          bounding_box: {
            x_min: 0.519,
            y_min: 0.633,
            x_max: 0.777,
            y_max: 0.834
          }
        },
        {
          label: "clothing_pile",
          confidence: 0.84,
          bounding_box: {
            x_min: 0.188,
            y_min: 0.461,
            x_max: 0.36,
            y_max: 0.606
          }
        },
        {
          label: "charging_cable",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.289,
            y_min: 0.519,
            x_max: 0.541,
            y_max: 0.825
          }
        },
        {
          label: "smartphone",
          confidence: 0.95,
          bounding_box: {
            x_min: 0.683,
            y_min: 0.55,
            x_max: 0.944,
            y_max: 0.818
          }
        },
        {
          label: "blanket",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.654,
            y_min: 0.556,
            x_max: 0.836,
            y_max: 0.717
          }
        },
        {
          label: "pillow",
          confidence: 0.98,
          bounding_box: {
            x_min: 0.251,
            y_min: 0.287,
            x_max: 0.372,
            y_max: 0.607
          }
        },
        {
          label: "water_bottle",
          confidence: 0.87,
          bounding_box: {
            x_min: 0.311,
            y_min: 0.178,
            x_max: 0.577,
            y_max: 0.305
          }
        }
      ]
    },
    user_productivity_rating: 2,
    user_mood_rating: 2,
    user_distraction_rating: 4,
    distraction_attribution: "interruption",
    distraction_source: "phone"
  },
  {
    id: "sess_031",
    timestamp: "2026-10-12T22:15:00-07:00",
    duration_mins: 45,
    location: "home",
    study_space: "desk",
    location_class: "home_desk",
    peceptron_tags: {
      clutter_score: 4,
      lighting: "bright",
      ergonomics: 8,
      detected_objects: [
        {
          label: "sticky_notes",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.488,
            y_min: 0.25,
            x_max: 0.76,
            y_max: 0.482
          }
        },
        {
          label: "external_monitor",
          confidence: 0.95,
          bounding_box: {
            x_min: 0.228,
            y_min: 0.515,
            x_max: 0.374,
            y_max: 0.734
          }
        },
        {
          label: "laptop",
          confidence: 0.95,
          bounding_box: {
            x_min: 0.491,
            y_min: 0.368,
            x_max: 0.764,
            y_max: 0.498
          }
        },
        {
          label: "mechanical_keyboard",
          confidence: 0.93,
          bounding_box: {
            x_min: 0.44,
            y_min: 0.104,
            x_max: 0.629,
            y_max: 0.273
          }
        },
        {
          label: "water_bottle",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.216,
            y_min: 0.28,
            x_max: 0.338,
            y_max: 0.572
          }
        },
        {
          label: "desk_lamp",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.297,
            y_min: 0.487,
            x_max: 0.532,
            y_max: 0.799
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 5,
    user_distraction_rating: 3,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_032",
    timestamp: "2026-10-13T15:00:00-07:00",
    duration_mins: 90,
    location: "classroom",
    study_space: "desk",
    location_class: "classroom_desk",
    peceptron_tags: {
      clutter_score: 3,
      lighting: "bright",
      ergonomics: 7,
      detected_objects: [
        {
          label: "desk_lamp",
          confidence: 0.88,
          bounding_box: {
            x_min: 0.064,
            y_min: 0.279,
            x_max: 0.368,
            y_max: 0.541
          }
        },
        {
          label: "sticky_notes",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.648,
            y_min: 0.148,
            x_max: 0.962,
            y_max: 0.324
          }
        },
        {
          label: "paper_stack",
          confidence: 0.87,
          bounding_box: {
            x_min: 0.391,
            y_min: 0.318,
            x_max: 0.582,
            y_max: 0.516
          }
        },
        {
          label: "highlighter",
          confidence: 0.8,
          bounding_box: {
            x_min: 0.159,
            y_min: 0.381,
            x_max: 0.305,
            y_max: 0.618
          }
        },
        {
          label: "notebook",
          confidence: 0.93,
          bounding_box: {
            x_min: 0.277,
            y_min: 0.5,
            x_max: 0.585,
            y_max: 0.807
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 2,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_033",
    timestamp: "2026-10-14T13:00:00-07:00",
    duration_mins: 60,
    location: "dorm_room",
    study_space: "bed",
    location_class: "dorm_room_bed",
    peceptron_tags: {
      clutter_score: 7,
      lighting: "dim",
      ergonomics: 1,
      detected_objects: [
        {
          label: "snack_wrapper",
          confidence: 0.8,
          bounding_box: {
            x_min: 0.355,
            y_min: 0.447,
            x_max: 0.658,
            y_max: 0.703
          }
        },
        {
          label: "clothing_pile",
          confidence: 0.82,
          bounding_box: {
            x_min: 0.098,
            y_min: 0.354,
            x_max: 0.227,
            y_max: 0.559
          }
        },
        {
          label: "tangled_wires",
          confidence: 0.76,
          bounding_box: {
            x_min: 0.469,
            y_min: 0.638,
            x_max: 0.61,
            y_max: 0.895
          }
        },
        {
          label: "charging_cable",
          confidence: 0.81,
          bounding_box: {
            x_min: 0.427,
            y_min: 0.625,
            x_max: 0.717,
            y_max: 0.754
          }
        },
        {
          label: "water_bottle",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.422,
            y_min: 0.204,
            x_max: 0.681,
            y_max: 0.439
          }
        },
        {
          label: "tablet",
          confidence: 0.94,
          bounding_box: {
            x_min: 0.343,
            y_min: 0.546,
            x_max: 0.656,
            y_max: 0.892
          }
        },
        {
          label: "pillow",
          confidence: 0.93,
          bounding_box: {
            x_min: 0.47,
            y_min: 0.122,
            x_max: 0.753,
            y_max: 0.47
          }
        },
        {
          label: "smartphone",
          confidence: 0.92,
          bounding_box: {
            x_min: 0.446,
            y_min: 0.3,
            x_max: 0.777,
            y_max: 0.509
          }
        }
      ]
    },
    user_productivity_rating: 1,
    user_mood_rating: 3,
    user_distraction_rating: 5,
    distraction_attribution: "unsure",
    distraction_source: "other"
  },
  {
    id: "sess_034",
    timestamp: "2026-10-15T15:00:00-07:00",
    duration_mins: 45,
    location: "dorm_room",
    study_space: "bed",
    location_class: "dorm_room_bed",
    peceptron_tags: {
      clutter_score: 8,
      lighting: "dim",
      ergonomics: 1,
      detected_objects: [
        {
          label: "tangled_wires",
          confidence: 0.82,
          bounding_box: {
            x_min: 0.504,
            y_min: 0.316,
            x_max: 0.761,
            y_max: 0.652
          }
        },
        {
          label: "pillow",
          confidence: 0.95,
          bounding_box: {
            x_min: 0.295,
            y_min: 0.535,
            x_max: 0.602,
            y_max: 0.809
          }
        },
        {
          label: "charging_cable",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.53,
            y_min: 0.477,
            x_max: 0.771,
            y_max: 0.746
          }
        },
        {
          label: "smartphone",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.285,
            y_min: 0.299,
            x_max: 0.446,
            y_max: 0.468
          }
        },
        {
          label: "headphones",
          confidence: 0.92,
          bounding_box: {
            x_min: 0.366,
            y_min: 0.225,
            x_max: 0.518,
            y_max: 0.363
          }
        },
        {
          label: "tablet",
          confidence: 0.93,
          bounding_box: {
            x_min: 0.116,
            y_min: 0.524,
            x_max: 0.428,
            y_max: 0.847
          }
        },
        {
          label: "snack_wrapper",
          confidence: 0.76,
          bounding_box: {
            x_min: 0.269,
            y_min: 0.521,
            x_max: 0.419,
            y_max: 0.728
          }
        },
        {
          label: "clothing_pile",
          confidence: 0.8,
          bounding_box: {
            x_min: 0.59,
            y_min: 0.524,
            x_max: 0.896,
            y_max: 0.682
          }
        },
        {
          label: "water_bottle",
          confidence: 0.86,
          bounding_box: {
            x_min: 0.317,
            y_min: 0.472,
            x_max: 0.492,
            y_max: 0.694
          }
        }
      ]
    },
    user_productivity_rating: 1,
    user_mood_rating: 2,
    user_distraction_rating: 1,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_035",
    timestamp: "2026-10-16T14:45:00-07:00",
    duration_mins: 50,
    location: "home",
    study_space: "bed",
    location_class: "home_bed",
    peceptron_tags: {
      clutter_score: 7,
      lighting: "dim",
      ergonomics: 2,
      detected_objects: [
        {
          label: "snack_wrapper",
          confidence: 0.77,
          bounding_box: {
            x_min: 0.213,
            y_min: 0.453,
            x_max: 0.534,
            y_max: 0.701
          }
        },
        {
          label: "headphones",
          confidence: 0.84,
          bounding_box: {
            x_min: 0.6,
            y_min: 0.568,
            x_max: 0.786,
            y_max: 0.864
          }
        },
        {
          label: "water_bottle",
          confidence: 0.84,
          bounding_box: {
            x_min: 0.638,
            y_min: 0.181,
            x_max: 0.859,
            y_max: 0.519
          }
        },
        {
          label: "tablet",
          confidence: 0.87,
          bounding_box: {
            x_min: 0.343,
            y_min: 0.292,
            x_max: 0.469,
            y_max: 0.424
          }
        },
        {
          label: "smartphone",
          confidence: 0.92,
          bounding_box: {
            x_min: 0.203,
            y_min: 0.647,
            x_max: 0.409,
            y_max: 0.773
          }
        },
        {
          label: "clothing_pile",
          confidence: 0.87,
          bounding_box: {
            x_min: 0.595,
            y_min: 0.457,
            x_max: 0.897,
            y_max: 0.609
          }
        },
        {
          label: "tangled_wires",
          confidence: 0.76,
          bounding_box: {
            x_min: 0.589,
            y_min: 0.483,
            x_max: 0.741,
            y_max: 0.765
          }
        }
      ]
    },
    user_productivity_rating: 2,
    user_mood_rating: 2,
    user_distraction_rating: 2,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_036",
    timestamp: "2026-10-16T17:00:00-07:00",
    duration_mins: 50,
    location: "library",
    study_space: "desk",
    location_class: "library_desk",
    peceptron_tags: {
      clutter_score: 1,
      lighting: "bright",
      ergonomics: 9,
      detected_objects: [
        {
          label: "desk_lamp",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.129,
            y_min: 0.231,
            x_max: 0.396,
            y_max: 0.494
          }
        },
        {
          label: "external_monitor",
          confidence: 0.92,
          bounding_box: {
            x_min: 0.594,
            y_min: 0.375,
            x_max: 0.837,
            y_max: 0.64
          }
        },
        {
          label: "notebook",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.517,
            y_min: 0.26,
            x_max: 0.637,
            y_max: 0.461
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 2,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_037",
    timestamp: "2026-10-16T20:45:00-07:00",
    duration_mins: 120,
    location: "library",
    study_space: "desk",
    location_class: "library_desk",
    peceptron_tags: {
      clutter_score: 3,
      lighting: "bright",
      ergonomics: 7,
      detected_objects: [
        {
          label: "water_bottle",
          confidence: 0.84,
          bounding_box: {
            x_min: 0.301,
            y_min: 0.305,
            x_max: 0.593,
            y_max: 0.507
          }
        },
        {
          label: "paper_stack",
          confidence: 0.83,
          bounding_box: {
            x_min: 0.207,
            y_min: 0.461,
            x_max: 0.351,
            y_max: 0.715
          }
        },
        {
          label: "laptop",
          confidence: 0.99,
          bounding_box: {
            x_min: 0.137,
            y_min: 0.294,
            x_max: 0.335,
            y_max: 0.562
          }
        },
        {
          label: "desk_lamp",
          confidence: 0.94,
          bounding_box: {
            x_min: 0.495,
            y_min: 0.639,
            x_max: 0.725,
            y_max: 0.801
          }
        },
        {
          label: "coffee_mug",
          confidence: 0.87,
          bounding_box: {
            x_min: 0.515,
            y_min: 0.619,
            x_max: 0.644,
            y_max: 0.785
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 4,
    user_distraction_rating: 4,
    distraction_attribution: "unsure",
    distraction_source: "other"
  },
  {
    id: "sess_038",
    timestamp: "2026-10-17T13:00:00-07:00",
    duration_mins: 120,
    location: "library",
    study_space: "desk",
    location_class: "library_desk",
    peceptron_tags: {
      clutter_score: 2,
      lighting: "bright",
      ergonomics: 10,
      detected_objects: [
        {
          label: "pen",
          confidence: 0.82,
          bounding_box: {
            x_min: 0.57,
            y_min: 0.34,
            x_max: 0.782,
            y_max: 0.561
          }
        },
        {
          label: "laptop",
          confidence: 0.99,
          bounding_box: {
            x_min: 0.27,
            y_min: 0.203,
            x_max: 0.549,
            y_max: 0.407
          }
        },
        {
          label: "paper_stack",
          confidence: 0.89,
          bounding_box: {
            x_min: 0.223,
            y_min: 0.145,
            x_max: 0.441,
            y_max: 0.364
          }
        }
      ]
    },
    user_productivity_rating: 5,
    user_mood_rating: 5,
    user_distraction_rating: 3,
    distraction_attribution: null,
    distraction_source: null
  },
  {
    id: "sess_039",
    timestamp: "2026-10-17T11:30:00-07:00",
    duration_mins: 45,
    location: "dorm_room",
    study_space: "bed",
    location_class: "dorm_room_bed",
    peceptron_tags: {
      clutter_score: 6,
      lighting: "dim",
      ergonomics: 2,
      detected_objects: [
        {
          label: "snack_wrapper",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.666,
            y_min: 0.141,
            x_max: 0.933,
            y_max: 0.345
          }
        },
        {
          label: "laptop",
          confidence: 0.97,
          bounding_box: {
            x_min: 0.492,
            y_min: 0.624,
            x_max: 0.645,
            y_max: 0.884
          }
        },
        {
          label: "charging_cable",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.073,
            y_min: 0.137,
            x_max: 0.372,
            y_max: 0.341
          }
        },
        {
          label: "water_bottle",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.419,
            y_min: 0.433,
            x_max: 0.695,
            y_max: 0.771
          }
        },
        {
          label: "pillow",
          confidence: 0.95,
          bounding_box: {
            x_min: 0.546,
            y_min: 0.416,
            x_max: 0.788,
            y_max: 0.628
          }
        },
        {
          label: "tablet",
          confidence: 0.91,
          bounding_box: {
            x_min: 0.212,
            y_min: 0.162,
            x_max: 0.501,
            y_max: 0.397
          }
        }
      ]
    },
    user_productivity_rating: 1,
    user_mood_rating: 2,
    user_distraction_rating: 4,
    distraction_attribution: "setup",
    distraction_source: "surroundings"
  },
  {
    id: "sess_040",
    timestamp: "2026-10-17T16:00:00-07:00",
    duration_mins: 50,
    location: "home",
    study_space: "bed",
    location_class: "home_bed",
    peceptron_tags: {
      clutter_score: 8,
      lighting: "dim",
      ergonomics: 3,
      detected_objects: [
        {
          label: "smartphone",
          confidence: 0.96,
          bounding_box: {
            x_min: 0.577,
            y_min: 0.632,
            x_max: 0.924,
            y_max: 0.906
          }
        },
        {
          label: "pillow",
          confidence: 0.98,
          bounding_box: {
            x_min: 0.407,
            y_min: 0.26,
            x_max: 0.596,
            y_max: 0.416
          }
        },
        {
          label: "clothing_pile",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.505,
            y_min: 0.196,
            x_max: 0.708,
            y_max: 0.368
          }
        },
        {
          label: "snack_wrapper",
          confidence: 0.85,
          bounding_box: {
            x_min: 0.565,
            y_min: 0.23,
            x_max: 0.799,
            y_max: 0.433
          }
        },
        {
          label: "tablet",
          confidence: 0.9,
          bounding_box: {
            x_min: 0.354,
            y_min: 0.641,
            x_max: 0.504,
            y_max: 0.964
          }
        },
        {
          label: "charging_cable",
          confidence: 0.79,
          bounding_box: {
            x_min: 0.309,
            y_min: 0.494,
            x_max: 0.539,
            y_max: 0.708
          }
        },
        {
          label: "blanket",
          confidence: 0.95,
          bounding_box: {
            x_min: 0.424,
            y_min: 0.169,
            x_max: 0.617,
            y_max: 0.306
          }
        }
      ]
    },
    user_productivity_rating: 2,
    user_mood_rating: 3,
    user_distraction_rating: 2,
    distraction_attribution: null,
    distraction_source: null
  }
];

// src/learning-web.ts
async function learningDashboard(authorization, request = fetch, base = process.env.SUPABASE_URL ?? "https://dhnmqgxjxwlfsmoaogvh.supabase.co") {
  const reply = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))
    return reply(401, { error: "Enter a dashboard code from your bot chat." });
  let url;
  try {
    url = new URL(base);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co") || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port)
      throw Error();
  } catch {
    return reply(503, { error: "Dashboard backend configuration needs attention." });
  }
  try {
    const r = await request(url.origin + "/functions/v1/model-dashboard", { headers: { Authorization: authorization }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12000) });
    if (!r.ok)
      return reply(r.status === 401 ? 401 : 502, { error: r.status === 401 ? "Dashboard code expired or disconnected. Request a new code from the bot." : "Dashboard connection is temporarily unavailable." });
    const data = await r.json();
    if (!data?.model || !Array.isArray(data.history) || !Array.isArray(data.events))
      throw Error();
    if (!data.insights) {
      const starter = insightObservations("0".repeat(64), [], seed_sessions_default);
      const recent = data.history.flatMap((h, i) => [h.productivity, h.mood, h.distraction].every((v) => Number.isInteger(v) && v >= 1 && v <= 5) ? [{ id: "recent:" + i, place: h.place, productivity: h.productivity, mood: h.mood, distraction: h.distraction, attribution: null, synthetic: false }] : []);
      const report = buildInsights([...starter, ...recent]);
      report.findings.push("This initial report uses combined learning history and your latest check-ins. Detailed attribution for older check-ins may be unavailable.");
      data.insights = { ...report, scheduled: false };
    }
    return reply(200, data);
  } catch {
    return reply(502, { error: "Dashboard connection is temporarily unavailable." });
  }
}

// src/schedule-review-public.ts
function scheduleReviewProjection(rows, now = Date.now()) {
  return rows.flatMap((raw) => {
    const p = raw?.review;
    const validRange = (v) => v && typeof v.start === "string" && typeof v.end === "string" && Number.isFinite(Date.parse(v.start)) && Date.parse(v.end) > Date.parse(v.start);
    if (!p || !/^[a-f0-9]{16}$/.test(p.id) || !["pending", "applied", "skipped", "stale"].includes(p.status) || !validRange(p.before) || p.after && !validRange(p.after) || !Number.isFinite(Date.parse(p.createdAt)) || !Number.isFinite(Date.parse(p.expiresAt)) || !Array.isArray(p.conflicts))
      return [];
    const text = (v) => typeof v === "string" ? v.slice(0, 500) : "";
    return [{ id: p.id, createdAt: p.createdAt, expiresAt: p.expiresAt, status: p.status === "pending" && Date.parse(p.expiresAt) <= now ? "stale" : p.status, title: text(p.title).slice(0, 160), before: { start: p.before.start, end: p.before.end }, after: p.after ? { start: p.after.start, end: p.after.end } : null, conflicts: p.conflicts.filter(validRange).slice(0, 20).map((c) => ({ title: text(c.title).slice(0, 160), start: c.start, end: c.end })), overlapMinutes: Number.isFinite(p.overlapMinutes) ? p.overlapMinutes : 0, shiftMinutes: Number.isFinite(p.shiftMinutes) ? p.shiftMinutes : null, reason: text(p.reason), model: p.model && [p.model.productivity, p.model.mood].every((v) => Number.isFinite(v) && v >= 1 && v <= 5) && Number.isInteger(p.model.observations) && p.model.observations > 0 ? { productivity: p.model.productivity, mood: p.model.mood, observations: p.model.observations } : null }];
  }).slice(0, 20);
}

// src/hosted-web.ts
var reply = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
async function hostedWeb(request, options = {}) {
  const url = new URL(request.url), route = url.searchParams.get("route");
  const path = route ? "/api/" + route : url.pathname, authorization = request.headers.get("authorization") ?? "";
  if (path === "/api/learning/dashboard")
    return request.method === "GET" ? learningDashboard(authorization, options.request) : reply(405, { error: "Read-only dashboard endpoint." });
  const match = path.match(/^\/api\/learning\/reviews\/([a-f0-9]{16})(?:\/(approve|deny))?$/);
  if (match) {
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))
      return reply(401, { error: "Open your private calendar review link." });
    if (!["GET", "POST"].includes(request.method) || request.method === "POST" !== Boolean(match[2]))
      return reply(405, { error: "Use an explicit review action." });
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin)
      return reply(403, { error: "Open the review on the Daywise website." });
    const configured = options.reviewBackend ?? process.env.REVIEW_BACKEND_URL;
    if (!configured)
      return reply(503, { error: "Calendar approval is not connected to this hosted site yet. You can still approve or skip in your bot chat." });
    let backend;
    try {
      backend = new URL(configured);
      if (backend.protocol !== "https:" || backend.username || backend.password || backend.search || backend.hash || backend.pathname !== "/" || backend.port)
        throw Error();
    } catch {
      return reply(503, { error: "The team needs to check the calendar approval connection." });
    }
    try {
      const result = await (options.request ?? fetch)(backend.origin + path, { method: request.method, headers: { Authorization: authorization }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(24000) });
      const data = await result.json();
      if (!result.ok)
        return reply(result.status === 401 ? 401 : result.status === 410 ? 410 : 503, { error: result.status === 410 ? "This review expired. Text review schedule for a fresh check." : "Could not load or confirm the review. Retry the same link or use your bot chat." });
      const review = scheduleReviewProjection([data])[0];
      if (!review || review.id !== match[1])
        throw Error();
      return reply(200, { review });
    } catch {
      return reply(503, { error: "The calendar worker is temporarily unavailable. Retry the same link; no duplicate event will be created." });
    }
  }
  if (path === "/api/auth/status" && request.method === "GET")
    return reply(200, { authenticated: false, liveGoogleConnected: false, privateDashboard: true });
  return reply(404, { error: "This action runs through your bot. Connect a private dashboard code to view your calendar and history." });
}

// src/hosted-entry.ts
var hosted_entry_default = { fetch: (request) => hostedWeb(request) };
export {
  hosted_entry_default as default
};
