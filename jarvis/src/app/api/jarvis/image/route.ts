import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';
import type { CreateImageGenerationBody } from 'z-ai-web-dev-sdk';

interface ImageRequest {
  prompt: string;
  size?: string;
}

type ImageSize = NonNullable<CreateImageGenerationBody['size']>;
const VALID_SIZES: readonly ImageSize[] = [
  '1024x1024',
  '768x1344',
  '864x1152',
  '1344x768',
  '1152x864',
  '1440x720',
  '720x1440',
];

function isImageSize(value: unknown): value is ImageSize {
  return typeof value === 'string' && (VALID_SIZES as readonly string[]).includes(value);
}

export async function POST(req: NextRequest) {
  try {
    const body: ImageRequest = await req.json();
    const { prompt, size } = body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return NextResponse.json(
        { error: 'Prompt is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    const selectedSize = size || '1024x1024';
    if (!isImageSize(selectedSize)) {
      return NextResponse.json(
        { error: `Invalid size "${selectedSize}". Valid sizes: ${VALID_SIZES.join(', ')}` },
        { status: 400 }
      );
    }

    const zai = await ZAI.create();
    const response = await zai.images.generations.create({
      prompt: prompt,
      size: selectedSize,
    });

    if (!response.data || response.data.length === 0 || !response.data[0].base64) {
      return NextResponse.json(
        { error: 'Image generation failed - no image data returned' },
        { status: 500 }
      );
    }

    const imageBase64 = response.data[0].base64;

    return NextResponse.json({
      image: imageBase64,
      prompt: prompt,
    });
  } catch (error) {
    console.error('[JARVIS Image] Error:', error);

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'An error occurred while generating the image' },
      { status: 500 }
    );
  }
}
