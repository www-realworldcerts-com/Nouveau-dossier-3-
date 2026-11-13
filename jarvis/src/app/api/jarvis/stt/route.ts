import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audioFile = formData.get('audio');

    if (!audioFile || !(audioFile instanceof File)) {
      return NextResponse.json(
        { error: 'Audio file is required (key: "audio")' },
        { status: 400 }
      );
    }

    // Validate file type
    const validTypes = [
      'audio/wav',
      'audio/mpeg',
      'audio/mp3',
      'audio/ogg',
      'audio/webm',
      'audio/mp4',
      'audio/x-m4a',
    ];
    if (!validTypes.includes(audioFile.type) && !audioFile.name.match(/\.(wav|mp3|ogg|webm|m4a|mp4)$/i)) {
      return NextResponse.json(
        { error: `Unsupported audio format: ${audioFile.type}. Supported formats: WAV, MP3, OGG, WebM, M4A` },
        { status: 400 }
      );
    }

    // Validate file size (max 25MB)
    const MAX_SIZE = 25 * 1024 * 1024;
    if (audioFile.size > MAX_SIZE) {
      return NextResponse.json(
        { error: 'Audio file too large. Maximum size is 25MB' },
        { status: 400 }
      );
    }

    const arrayBuffer = await audioFile.arrayBuffer();
    const audioBuffer = Buffer.from(new Uint8Array(arrayBuffer));
    const audioBase64 = audioBuffer.toString('base64');

    const zai = await ZAI.create();
    const response = await zai.audio.asr.create({
      file_base64: audioBase64,
    });

    const text = response.text || '';
    const confidence = response.confidence ?? 0.85;

    return NextResponse.json({
      text,
      confidence,
    });
  } catch (error) {
    console.error('[JARVIS STT] Error:', error);

    return NextResponse.json(
      { error: 'An error occurred while processing the audio file' },
      { status: 500 }
    );
  }
}
