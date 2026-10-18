# Personalized study coordinator

The running TypeScript bot uses xAI by default for chat, calendar interpretation, confirmed context extraction and proactive decisions. Set `AI_PROVIDER=gemini` to use Gemini for all those roles instead. Perceptron remains the workspace-photo extractor. See `.env.example` for public placeholders; credentials stay in private environment configuration.

LinUCB rebuilds from completed, correctly linked real feedback in Supabase and local history. It provides productivity/mood estimates, uncertainty and feasible session options. The coordinator also receives confirmed optional sentiment/social tags and authoritative current session state. Confirmed notes influence coordinator reasoning; they do not overwrite ratings or add numerical LinUCB features. Demo and real examples now share equal base weight in the configured combined learner, with separate counts. Synthetic examples are not personal experience; location comparisons still require known real profiles. See `CONTINUOUS_LEARNING.md`.

The event-triggered loop watches location, calendar, learning, confirmed notes, preferences and session changes. Persistent memory avoids model calls for unchanged one-minute polls. See `COORDINATOR_RUNTIME.md` for limits, retry behavior, privacy and the requirement to keep the computer awake.

A stable unsaved location can trigger an arrival check-in without a calendar opening. Saving a place is optional. Study invitations need a current opening, confirmation and a fresh location recheck; accepting starts tracking and attempts advance Calendar booking. Manually starting a session asks for a photo; successful photo analysis is followed by the optional energy question. Sending done logs the actual completed interval to Hackathon Demo and begins linked ratings. Existing proactive bookings are not duplicated.

Natural-language calendar additions use the deterministic Calendar handler after structured interpretation, ask for missing date/time/duration, and retain duplicate-safe event IDs. Study-location recommendations use real historical profiles and explain uncertainty rather than invent a favorite location. Historical setups are not current observations, and location associations are not causal evidence.

Use one responder per shared Photon/iMessage account, including across teammates' computers. The local startup lock prevents running both TypeScript launch paths on the same machine; it cannot stop a teammate's remote process.
