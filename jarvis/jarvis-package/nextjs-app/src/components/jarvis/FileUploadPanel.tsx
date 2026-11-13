'use client'

import { useState, useCallback, useRef } from 'react'
import { useJarvisStore } from '@/lib/jarvis-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Upload,
  FileText,
  ImageIcon,
  FileCode2,
  FileArchive,
  File,
  X,
  Send,
  Loader2,
  Bot,
  CloudUpload,
} from 'lucide-react'

interface UploadedFile {
  id: string
  name: string
  size: number
  type: string
  progress: number
  status: 'uploading' | 'analyzing' | 'complete' | 'error'
  analysis?: string
}

function getFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''

  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']
  const codeExts = [
    'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp',
    'h', 'html', 'css', 'scss', 'json', 'yaml', 'yml', 'xml', 'md',
  ]
  const archiveExts = ['zip', 'tar', 'gz', 'bz2', '7z', 'rar']

  if (imageExts.includes(ext)) return <ImageIcon className="size-5 text-purple-400" />
  if (codeExts.includes(ext)) return <FileCode2 className="size-5 text-[var(--jarvis)]" />
  if (archiveExts.includes(ext)) return <FileArchive className="size-5 text-amber-400" />
  if (ext === 'pdf' || ext === 'doc' || ext === 'docx' || ext === 'txt')
    return <FileText className="size-5 text-red-400" />
  return <File className="size-5 text-muted-foreground" />
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

export default function FileUploadPanel() {
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [question, setQuestion] = useState('')
  const [isAsking, setIsAsking] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { addMessage, setProcessing } = useJarvisStore()

  const uploadFile = useCallback(
    async (file: File) => {
      const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const newFile: UploadedFile = {
        id: fileId,
        name: file.name,
        size: file.size,
        type: file.type,
        progress: 0,
        status: 'uploading',
      }

      setFiles((prev) => [...prev, newFile])

      try {
        const formData = new FormData()
        formData.append('file', file)

        // Simulate progress
        let progress = 0
        const progressInterval = setInterval(() => {
          progress = Math.min(progress + Math.random() * 15, 90)
          setFiles((prev) =>
            prev.map((f) =>
              f.id === fileId ? { ...f, progress } : f
            )
          )
        }, 200)

        const res = await fetch('/api/jarvis/upload', {
          method: 'POST',
          body: formData,
        })

        clearInterval(progressInterval)

        if (!res.ok) throw new Error('Upload failed')

        const data = await res.json()

        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId
              ? {
                  ...f,
                  progress: 100,
                  status: 'complete' as const,
                  analysis: data.analysis || data.content || 'File uploaded and analyzed successfully.',
                }
              : f
          )
        )

        addMessage({
          id: `upload-${Date.now()}`,
          role: 'assistant',
          content: data.analysis || `I've analyzed "${file.name}". What would you like to know about it?`,
          timestamp: Date.now(),
          metadata: {
            type: 'file_upload',
            fileName: file.name,
            fileSize: file.size,
          },
        })
      } catch {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId
              ? { ...f, progress: 0, status: 'error' as const }
              : f
          )
        )
      }
    },
    [addMessage]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const droppedFiles = Array.from(e.dataTransfer.files)
      droppedFiles.forEach(uploadFile)
    },
    [uploadFile]
  )

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files
    if (selectedFiles) {
      Array.from(selectedFiles).forEach(uploadFile)
    }
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const removeFile = (fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId))
  }

  const askAboutFiles = async () => {
    if (!question.trim() || isAsking) return

    setIsAsking(true)
    setProcessing(true)

    try {
      const fileNames = files
        .filter((f) => f.status === 'complete')
        .map((f) => f.name)

      const res = await fetch('/api/jarvis/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Regarding the uploaded files (${fileNames.join(', ')}): ${question}`,
          history: [],
        }),
      })

      if (!res.ok) throw new Error('Chat request failed')

      const data = await res.json()

      addMessage({
        id: `file-ask-${Date.now()}`,
        role: 'assistant',
        content: data.response || data.content || 'Analysis complete.',
        timestamp: Date.now(),
        metadata: {
          type: 'file_upload',
        },
      })

      setQuestion('')
    } catch {
      addMessage({
        id: `file-ask-err-${Date.now()}`,
        role: 'system',
        content: 'Failed to analyze files. Please try again.',
        timestamp: Date.now(),
      })
    } finally {
      setIsAsking(false)
      setProcessing(false)
    }
  }

  const completedFiles = files.filter((f) => f.status === 'complete')

  return (
    <div className="flex flex-col h-full bg-[var(--surface)]/30 rounded-xl border border-[var(--jarvis-dark)]/20">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--jarvis-dark)]/20">
        <div className="flex items-center gap-2">
          <CloudUpload className="size-4 text-[var(--jarvis)]" />
          <span className="text-sm font-mono text-[var(--jarvis)]">File Analysis</span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          {completedFiles.length}/{files.length} processed
        </span>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Drop zone */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            className={`relative flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-xl cursor-pointer transition-all duration-200 ${
              isDragging
                ? 'border-[var(--jarvis)] bg-[var(--jarvis)]/5 shadow-[0_0_15px_var(--jarvis-glow)]'
                : 'border-[var(--jarvis-dark)]/30 bg-[var(--surface)]/50 hover:border-[var(--jarvis-dark)]/60 hover:bg-[var(--surface-light)]/30'
            }`}
          >
            <Upload
              className={`size-8 mb-3 transition-colors ${
                isDragging ? 'text-[var(--jarvis)]' : 'text-muted-foreground'
              }`}
            />
            <p className="text-sm font-mono text-foreground mb-1">
              {isDragging ? 'Drop files here' : 'Drag & drop files here'}
            </p>
            <p className="text-[10px] text-muted-foreground font-mono">
              or click to browse
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>

          {/* File list */}
          {files.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Uploaded Files
              </h3>
              {files.map((file) => (
                <Card
                  key={file.id}
                  className="bg-[var(--surface)] border-[var(--jarvis-dark)]/20"
                >
                  <CardContent className="p-3">
                    <div className="flex items-start gap-3">
                      <div className="shrink-0 mt-0.5">
                        {getFileIcon(file.name)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-foreground truncate">
                            {file.name}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 shrink-0 text-muted-foreground hover:text-red-400"
                            onClick={() => removeFile(file.id)}
                          >
                            <X className="size-3" />
                          </Button>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {formatFileSize(file.size)}
                          </span>
                          <Badge
                            variant="outline"
                            className={`text-[9px] px-1.5 py-0 ${
                              file.status === 'complete'
                                ? 'border-[var(--jarvis)]/30 text-[var(--jarvis)]'
                                : file.status === 'error'
                                  ? 'border-red-500/30 text-red-400'
                                  : file.status === 'analyzing'
                                    ? 'border-yellow-500/30 text-yellow-400'
                                    : 'border-muted-foreground/30 text-muted-foreground'
                            }`}
                          >
                            {file.status === 'uploading'
                              ? 'Uploading...'
                              : file.status === 'analyzing'
                                ? 'Analyzing...'
                                : file.status === 'complete'
                                  ? 'Analyzed'
                                  : 'Error'}
                          </Badge>
                        </div>
                        {/* Progress bar */}
                        {file.status === 'uploading' && (
                          <Progress
                            value={file.progress}
                            className="mt-2 h-1 bg-[var(--jarvis-dark)]/20"
                          />
                        )}
                        {/* Analysis result */}
                        {file.status === 'complete' && file.analysis && (
                          <div className="mt-2 p-2 rounded-md bg-[var(--surface-light)]/30 border border-[var(--jarvis-dark)]/10">
                            <div className="flex items-center gap-1 mb-1">
                              <Bot className="size-3 text-[var(--jarvis)]" />
                              <span className="text-[9px] font-mono text-[var(--jarvis)] uppercase">
                                JARVIS Analysis
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-3">
                              {file.analysis}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Ask about files */}
          {completedFiles.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Ask JARVIS about your files
              </h3>
              <div className="flex items-center gap-2">
                <Input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && askAboutFiles()}
                  placeholder="What would you like to know?"
                  disabled={isAsking}
                  className="bg-[var(--surface)] border-[var(--jarvis-dark)]/30 focus-visible:border-[var(--jarvis)] focus-visible:ring-[var(--jarvis)]/20 placeholder:text-muted-foreground/50 font-mono text-sm"
                />
                <Button
                  onClick={askAboutFiles}
                  disabled={!question.trim() || isAsking}
                  size="icon"
                  className="shrink-0 bg-[var(--jarvis-dark)] hover:bg-[var(--jarvis)] text-[var(--jarvis)] hover:text-black disabled:opacity-30"
                >
                  {isAsking ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          )}

          {files.length === 0 && (
            <div className="flex flex-col items-center py-6 text-center">
              <FileText className="size-8 text-[var(--jarvis-dark)] mb-2" />
              <p className="text-xs text-muted-foreground font-mono">
                Upload files for JARVIS to analyze
              </p>
              <p className="text-[10px] text-muted-foreground/50 font-mono mt-1">
                Supports code, documents, images, and more
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
