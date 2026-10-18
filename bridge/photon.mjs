// bridge/photon.mjs
// Photon Spectrum Cloud Bridge
// Connects to your dedicated Photon cloud phone number using SPECTRUM_PROJECT_ID & SPECTRUM_PROJECT_SECRET.
// Does NOT touch local chat.db or require Full Disk Access!

import { Spectrum } from 'spectrum-ts';
import { imessage } from '@spectrum-ts/imessage';
import fs from 'node:fs';

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
  SPECTRUM_PROJECT_ID,
  SPECTRUM_PROJECT_SECRET,
  BACKEND_URL = 'http://127.0.0.1:8000'
} = process.env;

if (!SPECTRUM_PROJECT_ID || !SPECTRUM_PROJECT_SECRET) {
  console.error('❌ Error: SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET are required in .env');
  process.exit(1);
}

console.log('🚀 Connecting to Photon Spectrum Cloud...');
console.log(`📱 Project ID: ${SPECTRUM_PROJECT_ID}`);
console.log(`📡 Backend URL: ${BACKEND_URL}`);

async function sendToPerceptronBackend(imageBuffer, mimeType = 'image/jpeg') {
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: mimeType });
  formData.append('file', blob, 'workspace_photo.jpg');

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

async function sendRatingFeedback(sessionId, rating) {
  const res = await fetch(`${BACKEND_URL}/api/rate-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      actual_rating: rating
    }),
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) throw new Error(`Rating failed (${res.status})`);
  return await res.json();
}

try {
  const app = await Spectrum({
    projectId: SPECTRUM_PROJECT_ID,
    projectSecret: SPECTRUM_PROJECT_SECRET,
    providers: [imessage.config()]
  });

  console.log('✅ Photon Spectrum successfully connected to your phone number!');
  console.log('👂 Listening for incoming photos & messages...');

  for await (const [space, message] of app.messages) {
    // Only process inbound messages sent to your Photon number
    if (message.direction !== 'inbound') continue;

    console.log(`📩 Incoming message (ID: ${message.id}, Type: ${message.content.type})`);

    try {
      // 1. Photo Attachment Received
      if (message.content.type === 'attachment') {
        const att = message.content;
        console.log(`📷 Photo received: ${att.name || 'attachment'} (${att.mimeType})`);

        await space.responding(async () => {
          await message.reply('🔄 Analyzing your workspace photo with Perceptron VLM... one moment!');
        });

        // Read attachment bytes
        const buffer = await att.read();
        const analysis = await sendToPerceptronBackend(buffer, att.mimeType || 'image/jpeg');

        console.log(`🎯 Analysis complete! Focus Score: ${analysis.focus_score}/100`);

        await space.responding(async () => {
          await message.reply(analysis.reply_text);
        });
        continue;
      }

      // 2. Text Command Received
      if (message.content.type === 'text') {
        const text = message.content.text.trim();
        const lower = text.toLowerCase();

        // Rate command
        const rateMatch = text.match(/rate\s+([a-zA-Z0-9_-]+)\s+([1-5](\.\d+)?)/i);
        if (rateMatch) {
          const sessId = rateMatch[1];
          const score = parseFloat(rateMatch[2]);
          await sendRatingFeedback(sessId, score);
          await space.responding(async () => {
            await message.reply(`✅ Recorded! Session ${sessId} rated ${score}/5. ML model parameters updated.`);
          });
          continue;
        }

        if (lower === 'help' || lower === 'start' || lower === 'score') {
          await space.responding(async () => {
            await message.reply(
              '👋 Welcome to Workspace Focus AI!\n\n' +
              '📸 Snap and text a photo of your desk or study space to this number.\n' +
              'Our Perceptron vision model will measure your lighting, clutter, and distractions to give you an instant Focus Score!\n\n' +
              'Reply "rate <session_id> <1-5>" after studying to tune your model.'
            );
          });
          continue;
        }

        // Default text fallback
        await space.responding(async () => {
          await message.reply('📸 Send a photo of your desk or study space to get your real-time Focus Score!');
        });
      }
    } catch (err) {
      console.error('❌ Error handling message:', err);
      try {
        await space.responding(async () => {
          await message.reply(`⚠️ Error: ${err.message}`);
        });
      } catch (replyErr) {
        console.error('Failed to send error reply:', replyErr);
      }
    }
  }

} catch (err) {
  console.error('❌ Fatal Spectrum Cloud error:', err);
  process.exit(1);
}
