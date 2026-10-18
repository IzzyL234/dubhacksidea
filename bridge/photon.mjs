// bridge/photon.mjs
// Unified Photon Spectrum Cloud Bridge:
// 1. Photo is sent -> Relays to Perceptron VLM backend (`analyze_workspace.py`) with per-user `user_id`,
//    logs photo metadata to Supabase (`public.workspace_photos_log`),
//    scores the study space with the user's LinUCB model (`public.user_model_params`),
//    and replies with Focus Score + Proven/Unexplored recommendations.
// 2. Links the photo session to `StudySessions` and triggers follow-up rating check-in (`FeedbackFlow`)
//    when the user finishes studying ("done" / "rate session") or chats with Grok (`XAI_API_KEY`).

import {acquireInstance,AlreadyRunning} from '../src/single-instance.ts';
import {fileURLToPath} from 'node:url';
import { Spectrum } from 'spectrum-ts';
import { imessage } from '@spectrum-ts/imessage';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { StudySessions } from '../src/sessions.ts';
import { FeedbackFlow } from '../src/feedback.ts';
import { inboundMessages } from '../src/inbound.ts';

const hashUser = (spaceId) => createHash('sha256').update(String(spaceId)).digest('hex');

// Load .env if present
if (fs.existsSync('.env')) {
  const envContent = fs.readFileSync('.env', 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const {
  PROJECT_ID,
  PROJECT_SECRET,
  SPECTRUM_PROJECT_ID,
  SPECTRUM_PROJECT_SECRET,
  BACKEND_URL = 'http://127.0.0.1:8000',
  XAI_API_KEY
} = process.env;

const projectId = PROJECT_ID || SPECTRUM_PROJECT_ID;
const projectSecret = PROJECT_SECRET || SPECTRUM_PROJECT_SECRET;

if (!projectId || !projectSecret) {
  console.error('❌ Error: SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET are required in .env');
  process.exit(1);
}

try { const release=acquireInstance(fileURLToPath(new URL('../data/runtime/bot-instance.json',import.meta.url))); process.once('exit',release); } catch(error) { if(error instanceof AlreadyRunning) {console.log(error.message);process.exit(0);} throw error; }

console.log('🚀 Connecting to Photon Spectrum Cloud...');
console.log(`📱 Project ID: ${projectId}`);
console.log(`📡 Perceptron + LinUCB Backend URL: ${BACKEND_URL}`);

// Track latest analyzed photo session ID per user key (`conversation_key`) so ratings link to `workspace_photos_log`
const latestPhotoSessionByUser = new Map();

// Initialize shared StudySessions & FeedbackFlow for training the per-user LinUCB model
const studySessions = new StudySessions();
const feedbackFlow = new FeedbackFlow(undefined, undefined, {
  begin: (key) => studySessions.beginFeedback(key),
  afterSave: async (record) => {
    await studySessions.completeFeedback(record);
    // Sync completed rating back to the FastAPI per-user LinUCB model & Supabase `workspace_photos_log`
    const linkedPhotoSessionId = latestPhotoSessionByUser.get(record.conversation_key) || record.session_id || record.id;
    try {
      await fetch(`${BACKEND_URL}/api/rate-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: linkedPhotoSessionId,
          user_id: record.conversation_key,
          actual_rating: record.productivity_rating,
          mood_rating: record.mood_rating,
          distraction_rating: record.distraction_rating,
          distraction_source: record.distraction_source
        }),
        signal: AbortSignal.timeout(10000)
      });
      console.log(`📈 Updated per-user LinUCB model (${record.conversation_key.slice(0, 8)}..., session=${linkedPhotoSessionId}): Productivity=${record.productivity_rating}/5, Mood=${record.mood_rating}/5`);
    } catch (e) {
      console.warn('Could not sync rating to FastAPI backend:', e.message);
    }
  },
  beforeUpload: (record) => studySessions.ensureCloud(record)
});

async function sendToPerceptronBackend(imageBuffer, mimeType = 'image/jpeg', userId = 'default_user') {
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: mimeType });
  formData.append('file', blob, 'workspace_photo.jpg');
  formData.append('user_id', userId);

  const res = await fetch(`${BACKEND_URL}/analyze-workspace`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(60000)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Backend (${res.status}): ${errText}`);
  }

  return await res.json();
}

async function triggerGrokFollowUpPrompt(analysis) {
  if (!XAI_API_KEY) return null;
  try {
    const response = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${XAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model: process.env.XAI_MODEL ?? 'grok-4.7',
        instructions:
          'You are a friendly personal study assistant. The user just sent a photo of their study workspace, which was scored by Perceptron and our LinUCB model. Write a short 1-2 sentence encouraging follow-up asking them to text "rate session" or "done" when they finish studying to rate their productivity (1-5), mood (1-5), and distractions so we can train their personal study space recommender.',
        input: `Workspace detected: ${analysis.location} (${analysis.study_space}), lighting: ${analysis.lighting_quality}, clutter: ${analysis.clutter_score}/10, focus score: ${analysis.focus_score}/100.`
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const reply = (data.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
    return reply || null;
  } catch {
    return null;
  }
}

try {
  const app = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()]
  });

  console.log('✅ Photon Spectrum successfully connected to your phone number!');
  console.log('👂 Listening for workspace photos & follow-up ratings...');

  for await (const [space, envelope] of app.messages) {
    for (const message of inboundMessages(envelope)) {
      if (message.direction !== 'inbound') continue;
      const userKey = hashUser(space.id);

      // 1. Handle Photo Attachment -> Perceptron VLM -> Supabase Photo Log -> Per-User LinUCB Score -> Follow-up Trigger
      if (message.content.type === 'attachment') {
        const att = message.content;
        const mime = (att.mimeType || '').toLowerCase();
        const name = (att.name || '').toLowerCase();

        const isImage =
          mime.startsWith('image/') ||
          ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp'].some((ext) => name.endsWith(ext));

        if (!isImage) continue;

        console.log(`📷 Photo received from user ${userKey.slice(0, 8)}...: ${att.name || 'image'} (${att.mimeType})`);

        try {
          await space.responding(async () => {
            await message.reply('🔄 Analyzing your workspace photo with Perceptron VLM & your personal LinUCB model... one moment!');
          });

          const buffer = await att.read();
          const analysis = await sendToPerceptronBackend(buffer, att.mimeType || 'image/jpeg', userKey);
          latestPhotoSessionByUser.set(userKey, analysis.session_id);

          // If a previous session was still active or awaiting feedback, discard it cleanly before autostarting the new photo session
          await studySessions.handle(space.id, 'discard session', `${message.id}:autoclear`);
          await feedbackFlow.handle(space.id, 'reset', `${message.id}:autoreset`);

          // Ensure a linked StudySession is active & populated with Perceptron context for `feedbackFlow`
          await studySessions.handle(space.id, 'start studying', `${message.id}:autostart`);
          const validLoc = ['home', 'dorm_room', 'library', 'classroom', 'cafe'].includes(analysis.location)
            ? analysis.location
            : 'library';
          const validSpace = ['chair', 'desk', 'shared_table', 'bed', 'beanbag'].includes(analysis.study_space)
            ? analysis.study_space
            : 'desk';
          await studySessions.handle(space.id, `${validLoc} ${validSpace} 45`, `${message.id}:autocontext`);
          await studySessions.handle(
            space.id,
            `workspace ${analysis.lighting_quality} ${Math.max(1, analysis.clutter_score)} ${Math.max(1, analysis.ergonomics_score)}`,
            `${message.id}:autoenv`
          );

          console.log(`🎯 Analysis logged & scored for user ${userKey.slice(0, 8)}...! Session: ${analysis.session_id}, Focus Score: ${analysis.focus_score}/100`);

          // Send Perceptron + LinUCB score reply
          await space.responding(async () => {
            await message.reply(analysis.reply_text);
          });

          // Trigger Grok follow-up / rating check-in prompt
          const grokFollowUp = await triggerGrokFollowUpPrompt(analysis);
          if (grokFollowUp) {
            await space.send(grokFollowUp);
          }
        } catch (err) {
          console.error('❌ Error analyzing workspace photo:', err);
          try {
            await space.responding(async () => {
              await message.reply(`⚠️ Error analyzing photo: ${err.message}`);
            });
          } catch {}
        }
        continue;
      }

      // 2. Handle Follow-up Rating Check-ins & Study Session Commands
      if (message.content.type === 'text') {
        const text = message.content.text.trim();
        if (!text) continue;

        try {
          // Direct inline rating e.g. "rate sess_abc123 5"
          const rateMatch = text.match(/^rate\s+(sess_[a-zA-Z0-9_-]+)\s+([1-5](?:\.\d+)?)(?:\s+([1-5](?:\.\d+)?))?$/i);
          if (rateMatch) {
            const sessId = rateMatch[1];
            const prodRating = parseFloat(rateMatch[2]);
            const moodRating = rateMatch[3] ? parseFloat(rateMatch[3]) : prodRating;
            await fetch(`${BACKEND_URL}/api/rate-session`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                session_id: sessId,
                user_id: userKey,
                actual_rating: prodRating,
                mood_rating: moodRating
              })
            });
            await space.send(`✅ Saved rating for ${sessId} (Productivity: ${prodRating}/5, Mood: ${moodRating}/5)! Your personal LinUCB study space recommender has been updated in Supabase.`);
            continue;
          }

          // Existing multi-step FeedbackFlow ("done", "rate session", or 1-5 replies during an active check-in)
          const feedbackReply = await feedbackFlow.handle(space.id, text, message.id);
          if (feedbackReply !== null) {
            await space.send(feedbackReply);
            continue;
          }

          // Existing StudySessions commands ("study score", "recommend space", "study status", "discard session")
          const sessionReply = await studySessions.handle(space.id, text, message.id);
          if (sessionReply !== null) {
            await space.send(sessionReply);
            continue;
          }
        } catch (err) {
          console.error('❌ Error in follow-up handler:', err);
        }
      }
    }
  }
} catch (err) {
  console.error('❌ Fatal Spectrum Cloud error:', err);
  process.exit(1);
}
