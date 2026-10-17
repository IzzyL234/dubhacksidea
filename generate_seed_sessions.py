#!/usr/bin/env python3
"""
generate_seed_sessions.py

Generates seed_sessions.json containing 40 realistic past study sessions across 3 weeks.
Updated Schema:
- location: larger location (e.g. library, cafe, classroom, dorm_room, home)
- study_space: specific micro space (e.g. desk, chair, beanbag, bed, shared_table)
- peceptron_tags (and perceptron_tags):
    - clutter_score (1-10)
    - lighting (dim/bright)
    - ergonomics (1-10)
    - detected_objects (with normalized bounding boxes)
- user_productivity_rating (1-5)
- user_mood_rating (1-5)

Maintains strong statistical correlations:
- bed / beanbag + dim lighting + high clutter -> low ratings (1-2)
- library / classroom / cafe + desk / shared_table + bright + low clutter -> high ratings (4-5)
"""

import json
import random
from datetime import datetime, timedelta, timezone

def generate_bounding_box():
    """Generates a realistic normalized bounding box [x_min, y_min, x_max, y_max]."""
    x_min = round(random.uniform(0.05, 0.70), 3)
    y_min = round(random.uniform(0.10, 0.65), 3)
    width = round(random.uniform(0.12, 0.35), 3)
    height = round(random.uniform(0.12, 0.35), 3)
    x_max = round(min(1.0, x_min + width), 3)
    y_max = round(min(1.0, y_min + height), 3)
    return {
        "x_min": x_min,
        "y_min": y_min,
        "x_max": x_max,
        "y_max": y_max
    }

def get_detected_objects(location, study_space, clutter_score):
    """Returns detected objects with bounding boxes tailored to location & study_space."""
    object_pools = {
        "bed": [
            ("laptop", 0.96), ("smartphone", 0.93), ("pillow", 0.98),
            ("blanket", 0.97), ("headphones", 0.89), ("charging_cable", 0.84),
            ("water_bottle", 0.88), ("snack_wrapper", 0.82), ("tablet", 0.91),
            ("tangled_wires", 0.79), ("clothing_pile", 0.85)
        ],
        "beanbag": [
            ("laptop", 0.94), ("smartphone", 0.92), ("throw_pillow", 0.90),
            ("headphones", 0.89), ("snack_wrapper", 0.85), ("energy_drink_can", 0.87),
            ("tablet", 0.91), ("slippers", 0.83), ("charging_cable", 0.81)
        ],
        "desk": [
            ("laptop", 0.98), ("external_monitor", 0.97), ("mechanical_keyboard", 0.95),
            ("mouse", 0.94), ("notebook", 0.91), ("pen", 0.86),
            ("desk_lamp", 0.93), ("coffee_mug", 0.92), ("water_bottle", 0.90),
            ("sticky_notes", 0.85), ("highlighter", 0.83), ("paper_stack", 0.88)
        ],
        "shared_table": [
            ("laptop", 0.98), ("textbook", 0.96), ("spiral_notebook", 0.94),
            ("ballpoint_pen", 0.88), ("highlighter", 0.87), ("backpack", 0.93),
            ("insulated_tumbler", 0.91), ("noise_cancelling_headphones", 0.95),
            ("study_guide", 0.89), ("desk_divider", 0.85)
        ],
        "chair": [
            ("laptop", 0.95), ("notebook", 0.89), ("ballpoint_pen", 0.85),
            ("backpack", 0.91), ("smartphone", 0.92), ("water_bottle", 0.88),
            ("pencil_case", 0.87)
        ]
    }

    pool = object_pools.get(study_space, object_pools["desk"])
    num_objects = min(len(pool), max(3, int(clutter_score * 0.8 + random.randint(1, 3))))
    selected = random.sample(pool, k=min(num_objects, len(pool)))

    detected = []
    for label, base_conf in selected:
        conf = round(max(0.70, min(0.99, base_conf + random.uniform(-0.06, 0.03))), 2)
        detected.append({
            "label": label,
            "confidence": conf,
            "bounding_box": generate_bounding_box()
        })
    return detected

def generate_sessions(count=40, seed=42):
    random.seed(seed)
    
    # Reference time: 2026-10-17 16:00:00 (Pacific Time UTC-7)
    tz = timezone(timedelta(hours=-7))
    end_time = datetime(2026, 10, 17, 16, 0, 0, tzinfo=tz)
    start_time = end_time - timedelta(days=21)

    # 40 planned (location, study_space) pairings
    pairings_plan = (
        [("dorm_room", "bed")] * 7 +
        [("home", "bed")] * 3 +
        [("dorm_room", "beanbag")] * 2 +
        [("library", "desk")] * 8 +
        [("library", "shared_table")] * 6 +
        [("classroom", "desk")] * 4 +
        [("classroom", "chair")] * 2 +
        [("cafe", "shared_table")] * 3 +
        [("cafe", "chair")] * 2 +
        [("home", "desk")] * 3
    )
    random.shuffle(pairings_plan)

    sessions = []
    total_seconds = int((end_time - start_time).total_seconds())
    offsets = sorted(random.sample(range(3600, total_seconds - 3600), count))

    for i, (offset_secs, (location, study_space)) in enumerate(zip(offsets, pairings_plan)):
        sess_dt = start_time + timedelta(seconds=offset_secs)
        target_hour = random.choice([9, 10, 11, 13, 14, 15, 16, 17, 19, 20, 21, 22])
        sess_dt = sess_dt.replace(hour=target_hour, minute=random.choice([0, 15, 30, 45]), second=0)

        # Environmental factors based on (location, study_space)
        if study_space == "bed":
            lighting = "dim" if random.random() < 0.85 else "bright"
            clutter_score = random.randint(6, 10) if lighting == "dim" else random.randint(4, 7)
            ergonomics = random.randint(1, 3)
            duration_mins = random.choice([25, 30, 45, 50, 60])
        elif study_space == "beanbag":
            lighting = "dim" if random.random() < 0.70 else "bright"
            clutter_score = random.randint(5, 8)
            ergonomics = random.randint(2, 4)
            duration_mins = random.choice([30, 45, 50])
        elif location in ["library", "classroom"]:
            lighting = "bright" if random.random() < 0.95 else "dim"
            clutter_score = random.randint(1, 3)
            ergonomics = random.randint(7, 10) if study_space == "desk" else random.randint(6, 9)
            duration_mins = random.choice([45, 50, 60, 90, 120])
        elif location == "cafe":
            lighting = "bright" if random.random() < 0.75 else "dim"
            clutter_score = random.randint(3, 6)
            ergonomics = random.randint(4, 6)
            duration_mins = random.choice([35, 45, 60, 75])
        else:  # home / dorm desk
            lighting = "bright" if random.random() < 0.80 else "dim"
            clutter_score = random.randint(1, 4) if lighting == "bright" else random.randint(4, 7)
            ergonomics = random.randint(6, 9)
            duration_mins = random.choice([30, 45, 50, 60, 90])

        # Statistical correlation model:
        space_weight = {
            "bed": -1.9,
            "beanbag": -1.2,
            "chair": 0.0,
            "shared_table": 1.1,
            "desk": 1.4
        }[study_space]

        loc_weight = {
            "library": 0.5,
            "classroom": 0.4,
            "home": 0.0,
            "dorm_room": -0.2,
            "cafe": 0.1
        }[location]

        light_weight = 0.9 if lighting == "bright" else -1.1
        clutter_penalty = -0.25 * (clutter_score - 2)
        ergo_weight = 0.18 * (ergonomics - 5)

        # Latent productivity calculation
        prod_latent = 3.0 + space_weight + loc_weight + light_weight + clutter_penalty + ergo_weight + random.gauss(0, 0.35)
        productivity_rating = int(round(max(1, min(5, prod_latent))))

        # Specific constraints:
        # 1. bed / beanbag + dim lighting -> low ratings (1-2, rarely 3)
        if study_space in ["bed", "beanbag"] and lighting == "dim":
            productivity_rating = random.choices([1, 2, 3], weights=[0.60, 0.35, 0.05])[0]

        # 2. library / classroom / desk with low clutter -> high productivity (4-5)
        if study_space in ["desk", "shared_table"] and clutter_score <= 4 and lighting == "bright":
            productivity_rating = random.choices([4, 5], weights=[0.30, 0.70])[0]

        # Mood correlated with productivity, ergonomics, and lighting
        mood_latent = 0.55 * productivity_rating + 0.25 * (ergonomics / 2.0) + (0.5 if lighting == "bright" else -0.5) + random.gauss(0, 0.3)
        mood_rating = int(round(max(1, min(5, mood_latent))))

        if study_space == "bed" and lighting == "dim":
            mood_rating = random.choices([1, 2, 3], weights=[0.55, 0.35, 0.10])[0]

        detected_objects = get_detected_objects(location, study_space, clutter_score)

        tags_dict = {
            "clutter_score": clutter_score,
            "lighting": lighting,
            "ergonomics": ergonomics,
            "detected_objects": detected_objects
        }

        session = {
            "id": f"sess_{i+1:03d}",
            "timestamp": sess_dt.isoformat(),
            "duration_mins": duration_mins,
            "location": location,
            "study_space": study_space,
            "location_class": f"{location}_{study_space}",
            "peceptron_tags": tags_dict,
            "user_productivity_rating": productivity_rating,
            "user_mood_rating": mood_rating
        }
        sessions.append(session)

    return sessions

def main():
    sessions = generate_sessions(count=40, seed=42)
    output_filename = "seed_sessions.json"

    with open(output_filename, "w", encoding="utf-8") as f:
        json.dump(sessions, f, indent=2)

    print(f"Successfully generated {len(sessions)} sessions in {output_filename}")

    # Statistical validation breakdown
    print("\n--- Summary Breakdown by (Location, Study Space, Lighting) ---")
    by_category = {}
    for s in sessions:
        loc = s["location"]
        space = s["study_space"]
        light = s["peceptron_tags"]["lighting"]
        cat = f"{loc} -> {space} ({light})"
        by_category.setdefault(cat, []).append((
            s["user_productivity_rating"],
            s["user_mood_rating"],
            s["peceptron_tags"]["clutter_score"]
        ))

    for cat, values in sorted(by_category.items()):
        avg_prod = sum(v[0] for v in values) / len(values)
        avg_mood = sum(v[1] for v in values) / len(values)
        avg_clutter = sum(v[2] for v in values) / len(values)
        print(f"  {cat:36s} | Count: {len(values):2d} | Avg Prod: {avg_prod:.2f}/5 | Avg Mood: {avg_mood:.2f}/5 | Avg Clutter: {avg_clutter:.1f}/10")

if __name__ == "__main__":
    main()
