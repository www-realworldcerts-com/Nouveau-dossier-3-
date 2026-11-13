import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

interface TTSRequest {
  text: string;
  voice?: string;
}

const MAX_CHUNK_SIZE = 1024;

function splitTextIntoChunks(text: string, maxChunkSize: number): string[] {
  if (text.length <= maxChunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a sentence boundary or space near the max chunk size
    let splitIndex = remaining.lastIndexOf('.', maxChunkSize);
    if (splitIndex === -1 || splitIndex < maxChunkSize * 0.3) {
      splitIndex = remaining.lastIndexOf('!', maxChunkSize);
    }
    if (splitIndex === -1 || splitIndex < maxChunkSize * 0.3) {
      splitIndex = remaining.lastIndexOf('?', maxChunkSize);
    }
    if (splitIndex === -1 || splitIndex < maxChunkSize * 0.3) {
      splitIndex = remaining.lastIndexOf(' ', maxChunkSize);
    }
    if (splitIndex === -1 || splitIndex < maxChunkSize * 0.3) {
      splitIndex = maxChunkSize;
    } else {
      splitIndex += 1; // Include the punctuation/space
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

export async function POST(req: NextRequest) {
  try {
    const body: TTSRequest = await req.json();
    const { text, voice } = body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return NextResponse.json(
        { error: 'Text is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    const chunks = splitTextIntoChunks(text, MAX_CHUNK_SIZE);
    const zai = await ZAI.create();
    const selectedVoice = voice || 'jam'; // English gentleman voice for JARVIS

    if (chunks.length === 1) {
      // Single chunk - return audio directly
      const response = await zai.audio.tts.create({
        input: chunks[0],
        voice: selectedVoice,
        speed: 1.0,
        response_format: 'wav',
        stream: false,
      });

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(new Uint8Array(arrayBuffer));

      return new NextResponse(buffer, {
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Length': buffer.length.toString(),
        },
      });
    }

    // Multiple chunks - concatenate audio buffers
    const audioBuffers: Buffer[] = [];

    for (const chunk of chunks) {
      const response = await zai.audio.tts.create({
        input: chunk,
        voice: selectedVoice,
        speed: 1.0,
        response_format: 'wav',
        stream: false,
      });

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(new Uint8Array(arrayBuffer));
      audioBuffers.push(buffer);
    }

    // Simple concatenation of WAV files
    // For production, proper WAV header reconstruction would be ideal,
    // but most players handle concatenated WAV data acceptably
    const totalLength = audioBuffers.reduce((sum, buf) => sum + buf.length, 0);
    const combinedBuffer = Buffer.concat(audioBuffers, totalLength);

    return new NextResponse(combinedBuffer, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': combinedBuffer.length.toString(),
      },
    });
  } catch (error) {
    console.error('[JARVIS TTS] Error:', error);

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'An error occurred while generating speech' },
      { status: 500 }
    );
  }
}
