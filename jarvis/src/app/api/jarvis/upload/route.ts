import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

// Supported file types
const IMAGE_TYPES = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/svg+xml', 'image/bmp',
];

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];

const TEXT_EXTENSIONS = [
  'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp',
  'h', 'html', 'css', 'scss', 'less', 'json', 'yaml', 'yml', 'xml', 'md',
  'txt', 'csv', 'sql', 'sh', 'bash', 'zsh', 'ini', 'cfg', 'conf', 'log',
  'env', 'gitignore', 'dockerignore', 'editorconfig', 'toml', 'swift',
  'kt', 'dart', 'lua', 'r', 'pl', 'php', 'vue', 'svelte',
];

const DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'rtf', 'odt'];

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

function getFileExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() || '';
}

function isImageFile(file: File): boolean {
  if (IMAGE_TYPES.includes(file.type)) return true;
  const ext = getFileExtension(file.name);
  return IMAGE_EXTENSIONS.includes(ext);
}

function isTextFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  if (TEXT_EXTENSIONS.includes(ext)) return true;
  if (file.type.startsWith('text/')) return true;
  if (file.type === 'application/json' || file.type === 'application/xml') return true;
  return false;
}

function isDocumentFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  return DOCUMENT_EXTENSIONS.includes(ext);
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: 'File is required (key: "file")' },
        { status: 400 }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` },
        { status: 400 }
      );
    }

    const ext = getFileExtension(file.name);
    const zai = await ZAI.create();

    // --- IMAGE FILES: Use VLM for analysis ---
    if (isImageFile(file)) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(new Uint8Array(arrayBuffer));
      const base64 = buffer.toString('base64');
      const mimeType = file.type || `image/${ext === 'jpg' ? 'jpeg' : ext}`;

      const dataUrl = `data:${mimeType};base64,${base64}`;

      const response = await zai.chat.completions.createVision({
        model: process.env.ZAI_VISION_MODEL || 'glm-4v',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are JARVIS, an advanced AI assistant. Analyze this image in detail. Describe what you see, identify key elements, and provide any relevant insights. Be thorough but concise.`,
              },
              {
                type: 'image_url',
                image_url: { url: dataUrl },
              },
            ],
          },
        ],
        thinking: { type: 'disabled' },
      });

      const analysis =
        response.choices?.[0]?.message?.content ||
        'Image uploaded successfully, but analysis could not be completed.';

      return NextResponse.json({
        success: true,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || `image/${ext}`,
        analysis,
        analysisType: 'vision',
      });
    }

    // --- TEXT/CODE FILES: Read content and use LLM ---
    if (isTextFile(file)) {
      const arrayBuffer = await file.arrayBuffer();
      let content: string;

      try {
        content = new TextDecoder('utf-8').decode(arrayBuffer);
      } catch {
        content = '[Binary content - could not decode as text]';
      }

      // Truncate very large files to avoid token limits
      const MAX_CONTENT_LENGTH = 15000;
      const truncated = content.length > MAX_CONTENT_LENGTH;
      const fileContent = truncated
        ? content.slice(0, MAX_CONTENT_LENGTH) + '\n\n... [TRUNCATED - File too large for full analysis]'
        : content;

      const response = await zai.chat.completions.create({
        messages: [
          {
            role: 'assistant',
            content: `You are JARVIS, an advanced AI assistant. You analyze files with precision and insight. Provide clear, structured analysis.`,
          },
          {
            role: 'user',
            content: `Analyze the following file "${file.name}" (${file.type || ext}, ${formatFileSize(file.size)}${truncated ? ', truncated' : ''}):\n\n\`\`\`${ext}\n${fileContent}\n\`\`\`\n\nProvide a concise but thorough analysis including: 1) File purpose and structure 2) Key content/observations 3) Any notable patterns, issues, or suggestions.`,
          },
        ],
        thinking: { type: 'disabled' },
      });

      const analysis =
        response.choices?.[0]?.message?.content ||
        'File uploaded successfully, but analysis could not be completed.';

      return NextResponse.json({
        success: true,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || `text/${ext}`,
        content: fileContent,
        analysis,
        analysisType: 'text',
        truncated,
      });
    }

    // --- DOCUMENT/OTHER FILES: Basic info + LLM summary ---
    if (isDocumentFile(file)) {
      const response = await zai.chat.completions.create({
        messages: [
          {
            role: 'assistant',
            content: `You are JARVIS, an advanced AI assistant. You help users understand their uploaded files.`,
          },
          {
            role: 'user',
            content: `A document file was uploaded: "${file.name}" (${file.type || ext}, ${formatFileSize(file.size)}). This appears to be a ${ext.toUpperCase()} document. Based on the file name and type, provide a brief summary of what this file likely contains and suggest how the user might want to interact with it. Mention that for detailed document analysis, the user can ask specific questions.`,
          },
        ],
        thinking: { type: 'disabled' },
      });

      const analysis =
        response.choices?.[0]?.message?.content ||
        'Document uploaded successfully. You can ask me questions about it.';

      return NextResponse.json({
        success: true,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || `application/${ext}`,
        analysis,
        analysisType: 'document',
      });
    }

    // --- UNSUPPORTED/UNKNOWN FILES ---
    const response = await zai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content: `You are JARVIS, an advanced AI assistant.`,
        },
        {
          role: 'user',
          content: `A file was uploaded: "${file.name}" (${file.type || 'unknown type'}, ${formatFileSize(file.size)}). The file format is not directly analyzable. Provide a brief, friendly response acknowledging the upload and suggesting the user can ask questions or provide more context.`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const analysis =
      response.choices?.[0]?.message?.content ||
      'File uploaded successfully. How can I help you with it?';

    return NextResponse.json({
      success: true,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream',
      analysis,
      analysisType: 'generic',
    });
  } catch (error) {
    console.error('[JARVIS Upload] Error:', error);

    return NextResponse.json(
      { error: 'An error occurred while processing the uploaded file' },
      { status: 500 }
    );
  }
}
