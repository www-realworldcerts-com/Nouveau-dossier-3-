"""
JARVIS Upload Handler Module

Provides comprehensive file upload processing, text extraction, and
LLM-based analysis for the JARVIS AI Agent. Supports 50+ file extensions
across code, documents, data, and media formats.

Features:
    - Support for 50+ file extensions across 8 categories
    - Text extraction from code, documents, data, and markup files
    - LLM-based intelligent analysis of file contents
    - Personalization profile building from uploaded files
    - File size validation (max 50MB)
    - Filename sanitization for safe storage
    - Automatic file type detection by extension
    - Batch processing of multiple uploads

Supported File Categories:
    - Code: Python, JS/TS, Go, Rust, Java, C/C++, Ruby, PHP, Swift, Kotlin
    - Web: HTML, CSS, SCSS, LESS, Vue, Svelte
    - Data: JSON, YAML, TOML, XML, CSV, TSV, INI, ENV
    - Documents: Markdown, TXT, PDF, DOCX, RTF
    - Config: Dockerfile, Makefile, .env, gitignore, editorconfig
    - Archives: ZIP (listing only)
    - Images: PNG, JPG, GIF, SVG, WebP (metadata extraction)
    - Shell: Bash, Zsh, Fish, PowerShell
"""

from __future__ import annotations

import base64
import csv
import io
import json
import logging
import os
import re
import shutil
import tempfile
import time
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Maximum file size: 50MB
MAX_FILE_SIZE: int = 50 * 1024 * 1024

# ─── File Extension Categories ────────────────────────────────────────────

FILE_CATEGORIES: dict[str, set[str]] = {
    "python": {".py", ".pyw", ".pyx", ".pyi", ".pyd", ".ipynb"},
    "javascript": {".js", ".jsx", ".mjs", ".cjs"},
    "typescript": {".ts", ".tsx", ".mts", ".cts", ".d.ts"},
    "go": {".go"},
    "rust": {".rs", ".toml"},
    "java": {".java", ".jar", ".gradle", ".kt", ".kts"},
    "c_cpp": {".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"},
    "ruby": {".rb", ".erb", ".gemspec", ".rake"},
    "php": {".php", ".phtml", ".php3", ".php4", ".php5"},
    "swift": {".swift"},
    "csharp": {".cs", ".csx", ".vb"},
    "scala": {".scala", ".sbt"},
    "html": {".html", ".htm", ".xhtml"},
    "css": {".css", ".scss", ".sass", ".less"},
    "vue": {".vue"},
    "svelte": {".svelte"},
    "json": {".json", ".jsonl", ".json5"},
    "yaml": {".yaml", ".yml"},
    "toml": {".toml"},
    "xml": {".xml", ".xsd", ".xsl", ".xslt", ".svg"},
    "csv": {".csv", ".tsv"},
    "markdown": {".md", ".mdx", ".rst", ".txt"},
    "pdf": {".pdf"},
    "docx": {".docx", ".doc"},
    "rtf": {".rtf"},
    "ini": {".ini", ".cfg", ".conf", ".env", ".properties"},
    "shell": {".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd"},
    "dockerfile": {"Dockerfile", ".dockerfile", "docker-compose.yml", "docker-compose.yaml"},
    "makefile": {"Makefile", "makefile", "GNUmakefile"},
    "git": {".gitignore", ".gitattributes", ".gitmodules"},
    "editorconfig": {".editorconfig"},
    "image": {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp"},
    "archive": {".zip", ".tar", ".gz", ".bz2", ".xz", ".7z"},
    "sql": {".sql"},
    "graphql": {".graphql", ".gql"},
    "proto": {".proto"},
    "latex": {".tex", ".bib"},
    "log": {".log"},
}

# Flatten all extensions for quick lookup
ALL_EXTENSIONS: dict[str, str] = {}
for category, extensions in FILE_CATEGORIES.items():
    for ext in extensions:
        ALL_EXTENSIONS[ext.lower()] = category


class FileTypeInfo:
    """Information about a file type and how to process it.

    Attributes:
        extension: The file extension.
        category: The file category.
        is_text: Whether the file can be read as text.
        is_code: Whether the file is source code.
        is_binary: Whether the file is binary format.
        language: The programming language (for code files).
    """

    def __init__(
        self,
        extension: str,
        category: str,
        is_text: bool = True,
        is_code: bool = False,
        is_binary: bool = False,
        language: Optional[str] = None,
    ) -> None:
        """Initialize FileTypeInfo.

        Args:
            extension: The file extension.
            category: The file category.
            is_text: Whether the file is text-readable.
            is_code: Whether the file is source code.
            is_binary: Whether the file is binary.
            language: Programming language name.
        """
        self.extension: str = extension
        self.category: str = category
        self.is_text: bool = is_text
        self.is_code: bool = is_code
        self.is_binary: bool = is_binary
        self.language: Optional[str] = language

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "extension": self.extension,
            "category": self.category,
            "is_text": self.is_text,
            "is_code": self.is_code,
            "is_binary": self.is_binary,
            "language": self.language,
        }


# Code languages mapping
CODE_LANGUAGES: dict[str, str] = {
    "python": "Python",
    "javascript": "JavaScript",
    "typescript": "TypeScript",
    "go": "Go",
    "rust": "Rust",
    "java": "Java",
    "c_cpp": "C/C++",
    "ruby": "Ruby",
    "php": "PHP",
    "swift": "Swift",
    "csharp": "C#",
    "scala": "Scala",
    "vue": "Vue",
    "svelte": "Svelte",
    "shell": "Shell",
    "sql": "SQL",
    "graphql": "GraphQL",
    "proto": "Protocol Buffers",
    "latex": "LaTeX",
}


def sanitize_filename(filename: str) -> str:
    """Sanitize a filename for safe filesystem storage.

    Removes or replaces characters that are unsafe for filenames
    across different operating systems.

    Args:
        filename: The original filename string.

    Returns:
        A sanitized filename string safe for filesystem storage.
    """
    # Remove path components
    filename = os.path.basename(filename)

    # Replace unsafe characters
    sanitized = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', filename)

    # Remove leading dots and spaces
    sanitized = sanitized.lstrip('. ')

    # Limit length
    name, ext = os.path.splitext(sanitized)
    if len(name) > 200:
        name = name[:200]
    sanitized = name + ext

    # Ensure non-empty
    if not sanitized:
        sanitized = f"upload_{int(time.time())}"

    return sanitized


class UploadHandler:
    """Comprehensive file upload handler for JARVIS AI Agent.

    Processes uploaded files by extracting text content, detecting file
    types, and optionally analyzing content with an LLM. Builds
    personalization profiles from accumulated uploads.

    Args:
        max_file_size: Maximum allowed file size in bytes (default: 50MB).
        upload_dir: Directory for storing uploaded files.
        openai_api_key: Optional OpenAI API key for LLM analysis.
        openai_model: Model name for LLM analysis (default: gpt-4).

    Example:
        >>> handler = UploadHandler(upload_dir="/tmp/jarvis_uploads")
        >>> result = handler.process_upload(
        ...     file_path="/path/to/file.py",
        ...     file_name="example.py",
        ...     file_type="python",
        ... )
        >>> profile = handler._build_personalization_profile(handler._uploads)
    """

    def __init__(
        self,
        max_file_size: int = MAX_FILE_SIZE,
        upload_dir: Optional[str] = None,
        openai_api_key: Optional[str] = None,
        openai_model: str = "gpt-4",
    ) -> None:
        """Initialize the UploadHandler.

        Args:
            max_file_size: Maximum file size in bytes.
            upload_dir: Directory for file storage.
            openai_api_key: OpenAI API key for LLM analysis.
            openai_model: OpenAI model for analysis.
        """
        self.max_file_size: int = max_file_size
        self._upload_dir: str = upload_dir or tempfile.mkdtemp(prefix="jarvis_uploads_")
        self._openai_api_key: Optional[str] = openai_api_key
        self._openai_model: str = openai_model

        # Upload history
        self._uploads: list[dict[str, Any]] = []

        # Ensure upload directory exists
        os.makedirs(self._upload_dir, exist_ok=True)

        logger.info(
            "UploadHandler initialized: dir=%s, max_size=%dMB",
            self._upload_dir,
            self.max_file_size // (1024 * 1024),
        )

    def process_upload(
        self,
        file_path: str,
        file_name: str,
        file_type: Optional[str] = None,
    ) -> dict[str, Any]:
        """Process an uploaded file with validation, extraction, and analysis.

        Validates the file, extracts text content, and optionally
        analyzes it with an LLM. The result includes metadata, content
        summary, and analysis.

        Args:
            file_path: Path to the uploaded file.
            file_name: Original filename of the upload.
            file_type: Optional explicit file type override.

        Returns:
            A dictionary with processing results including:
            - success: Whether processing succeeded
            - filename: The sanitized filename
            - file_type: Detected or provided file type
            - file_size: File size in bytes
            - content: Extracted text content (truncated if large)
            - summary: Brief content summary
            - analysis: LLM analysis (if API key configured)
            - personalization: Extracted personalization data
            - error: Error message if processing failed

        Raises:
            FileNotFoundError: If the file doesn't exist.
            ValueError: If the file exceeds the size limit.
        """
        start_time = time.time()

        # Validate file existence
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        # Validate file size
        file_size = os.path.getsize(file_path)
        if file_size > self.max_file_size:
            raise ValueError(
                f"File size ({file_size} bytes) exceeds maximum "
                f"({self.max_file_size} bytes)"
            )

        # Sanitize filename
        safe_name = sanitize_filename(file_name)

        # Detect file type
        ext = Path(file_name).suffix.lower()
        # Handle files without extension (e.g., Dockerfile, Makefile)
        if not ext:
            base = Path(file_name).name.lower()
            for special_ext in ALL_EXTENSIONS:
                if not special_ext.startswith(".") and base == special_ext.lower():
                    ext = special_ext
                    break

        detected_category = file_type or ALL_EXTENSIONS.get(ext, "unknown")

        # Store file
        dest_path = os.path.join(self._upload_dir, safe_name)
        if file_path != dest_path:
            shutil.copy2(file_path, dest_path)

        # Extract text content
        try:
            content = self._extract_text(file_path, detected_category)
        except Exception as e:
            logger.error("Text extraction failed for %s: %s", safe_name, e)
            content = ""

        # Build file info
        file_info: dict[str, Any] = {
            "filename": safe_name,
            "original_name": file_name,
            "file_type": detected_category,
            "extension": ext,
            "file_size": file_size,
            "content_length": len(content),
            "upload_path": dest_path,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
        }

        # Analyze with LLM if content available
        analysis = ""
        summary = ""
        personalization = {}
        if content and self._openai_api_key:
            try:
                analysis = self._analyze_with_llm(content, file_info)
            except Exception as e:
                logger.warning("LLM analysis failed: %s", e)
                analysis = ""

        # Generate summary
        if content:
            summary = self._generate_summary(content, detected_category)

        # Extract personalization data
        if content:
            personalization = self._extract_personalization_data(content, detected_category)

        # Build result
        result: dict[str, Any] = {
            "success": True,
            **file_info,
            "content": content[:10000] if content else "",  # Truncate for response
            "content_full_length": len(content),
            "summary": summary,
            "analysis": analysis,
            "personalization": personalization,
            "processing_time_ms": int((time.time() - start_time) * 1000),
        }

        # Track the upload
        upload_record = {**result}
        upload_record["content"] = content  # Store full content in record
        self._uploads.append(upload_record)

        logger.info(
            "File processed: %s (%s, %d bytes, %dms)",
            safe_name,
            detected_category,
            file_size,
            result["processing_time_ms"],
        )

        return result

    def _extract_text(self, file_path: str, file_type: str) -> str:
        """Extract text content from a file based on its type.

        Args:
            file_path: Path to the file.
            file_type: The file category/type.

        Returns:
            Extracted text content as a string.

        Raises:
            ValueError: If the file type is not supported for text extraction.
        """
        # Binary file types that need special handling
        binary_types = {"pdf", "docx", "image", "archive", "rtf"}

        if file_type in binary_types:
            return self._extract_binary_text(file_path, file_type)

        # Text-based files
        code_types = {
            "python", "javascript", "typescript", "go", "rust", "java",
            "c_cpp", "ruby", "php", "swift", "csharp", "scala",
            "html", "css", "vue", "svelte", "shell", "sql", "graphql",
            "proto", "latex",
        }

        data_types = {"json", "yaml", "toml", "xml", "csv", "ini"}
        doc_types = {"markdown", "log"}
        config_types = {"dockerfile", "makefile", "git", "editorconfig"}

        if file_type in code_types or file_type in data_types or file_type in doc_types or file_type in config_types:
            return self._extract_text_file(file_path, file_type)

        # Try reading as plain text for unknown types
        try:
            return self._extract_text_file(file_path, file_type)
        except (UnicodeDecodeError, Exception):
            logger.warning("Cannot extract text from %s file", file_type)
            return f"[Binary file of type: {file_type}]"

    def _extract_text_file(self, file_path: str, file_type: str) -> str:
        """Extract text from a text-based file.

        Args:
            file_path: Path to the file.
            file_type: The file category.

        Returns:
            The file's text content.
        """
        # Special handling for CSV/TSV
        if file_type == "csv":
            return self._extract_csv(file_path)

        # Special handling for JSON
        if file_type == "json":
            return self._extract_json(file_path)

        # Read as UTF-8 text
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except UnicodeDecodeError:
            try:
                with open(file_path, "r", encoding="latin-1") as f:
                    content = f.read()
            except Exception as e:
                logger.error("Failed to read file %s: %s", file_path, e)
                return ""

        # Add code file header for context
        language = CODE_LANGUAGES.get(file_type, file_type)
        if file_type in CODE_LANGUAGES:
            line_count = content.count("\n") + 1
            header = (
                f"[File: {os.path.basename(file_path)} | "
                f"Language: {language} | Lines: {line_count}]\n\n"
            )
            return header + content

        return content

    def _extract_csv(self, file_path: str) -> str:
        """Extract and format CSV file content.

        Args:
            file_path: Path to the CSV file.

        Returns:
            Formatted string representation of the CSV data.
        """
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                # Detect dialect
                sample = f.read(8192)
                f.seek(0)

                # Check if TSV
                dialect = csv.excel_tab if "\t" in sample[:200] else csv.excel

                reader = csv.reader(f, dialect)
                rows = list(reader)

                if not rows:
                    return "[Empty CSV file]"

                # Format as a readable table
                headers = rows[0] if rows else []
                data_rows = rows[1:] if len(rows) > 1 else []

                # Limit output
                max_rows = 100
                display_rows = data_rows[:max_rows]

                lines: list[str] = []
                lines.append(f"CSV Data ({len(data_rows)} rows, {len(headers)} columns)")
                lines.append(f"Headers: {', '.join(headers)}")
                lines.append("")

                for row in display_rows:
                    lines.append(" | ".join(str(cell)[:50] for cell in row))

                if len(data_rows) > max_rows:
                    lines.append(f"... and {len(data_rows) - max_rows} more rows")

                return "\n".join(lines)

        except Exception as e:
            logger.error("CSV extraction failed: %s", e)
            return f"[CSV extraction error: {e}]"

    def _extract_json(self, file_path: str) -> str:
        """Extract and format JSON file content.

        Args:
            file_path: Path to the JSON file.

        Returns:
            Formatted JSON string.
        """
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return json.dumps(data, indent=2, ensure_ascii=False, default=str)
        except json.JSONDecodeError as e:
            logger.warning("Invalid JSON in %s: %s", file_path, e)
            # Fall back to raw text
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                return f.read()

    def _extract_binary_text(self, file_path: str, file_type: str) -> str:
        """Extract text from binary file formats.

        Args:
            file_path: Path to the file.
            file_type: The file category.

        Returns:
            Extracted text or metadata string.
        """
        if file_type == "pdf":
            return self._extract_pdf(file_path)
        elif file_type == "docx":
            return self._extract_docx(file_path)
        elif file_type == "image":
            return self._extract_image_metadata(file_path)
        elif file_type == "archive":
            return self._extract_archive_listing(file_path)
        elif file_type == "rtf":
            return self._extract_rtf(file_path)
        else:
            return f"[Binary file of type: {file_type}]"

    def _extract_pdf(self, file_path: str) -> str:
        """Extract text from a PDF file.

        Args:
            file_path: Path to the PDF file.

        Returns:
            Extracted text content from the PDF.
        """
        try:
            import PyPDF2
            with open(file_path, "rb") as f:
                reader = PyPDF2.PdfReader(f)
                pages = []
                for i, page in enumerate(reader.pages):
                    text = page.extract_text()
                    if text:
                        pages.append(f"--- Page {i + 1} ---\n{text}")
                return "\n\n".join(pages)
        except ImportError:
            logger.warning("PyPDF2 not installed, cannot extract PDF text")
            return f"[PDF file - text extraction unavailable (install PyPDF2)]"
        except Exception as e:
            logger.error("PDF extraction failed: %s", e)
            return f"[PDF extraction error: {e}]"

    def _extract_docx(self, file_path: str) -> str:
        """Extract text from a DOCX file.

        Args:
            file_path: Path to the DOCX file.

        Returns:
            Extracted text content from the DOCX.
        """
        try:
            from docx import Document
            doc = Document(file_path)
            paragraphs = [para.text for para in doc.paragraphs if para.text]
            return "\n\n".join(paragraphs)
        except ImportError:
            logger.warning("python-docx not installed, cannot extract DOCX text")
            return f"[DOCX file - text extraction unavailable (install python-docx)]"
        except Exception as e:
            logger.error("DOCX extraction failed: %s", e)
            return f"[DOCX extraction error: {e}]"

    def _extract_image_metadata(self, file_path: str) -> str:
        """Extract metadata from an image file.

        Args:
            file_path: Path to the image file.

        Returns:
            A string describing the image metadata.
        """
        try:
            from PIL import Image
            with Image.open(file_path) as img:
                info = [
                    f"Image: {os.path.basename(file_path)}",
                    f"Format: {img.format}",
                    f"Size: {img.size[0]}x{img.size[1]} pixels",
                    f"Mode: {img.mode}",
                ]
                if hasattr(img, "_getexif") and img._getexif():
                    exif = img._getexif()
                    if exif:
                        info.append(f"EXIF tags: {len(exif)} entries")
                return "\n".join(info)
        except ImportError:
            file_size = os.path.getsize(file_path)
            ext = Path(file_path).suffix
            return f"[Image file: {ext}, {file_size} bytes - install Pillow for metadata]"
        except Exception as e:
            return f"[Image metadata extraction error: {e}]"

    def _extract_archive_listing(self, file_path: str) -> str:
        """List contents of an archive file.

        Args:
            file_path: Path to the archive file.

        Returns:
            A string listing the archive contents.
        """
        ext = Path(file_path).suffix.lower()
        if ext == ".zip":
            try:
                with zipfile.ZipFile(file_path, "r") as zf:
                    names = zf.namelist()
                    lines = [f"ZIP Archive: {len(names)} entries", ""]
                    for name in names[:50]:
                        info = zf.getinfo(name)
                        lines.append(f"  {name} ({info.file_size} bytes)")
                    if len(names) > 50:
                        lines.append(f"  ... and {len(names) - 50} more entries")
                    return "\n".join(lines)
            except Exception as e:
                return f"[Archive listing error: {e}]"

        return f"[Archive file: {ext}]"

    def _extract_rtf(self, file_path: str) -> str:
        """Extract text from an RTF file.

        Args:
            file_path: Path to the RTF file.

        Returns:
            Stripped text from the RTF file.
        """
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            # Simple RTF stripping - remove control words
            text = re.sub(r'\\[a-z]+\d*\s?', '', content)
            text = re.sub(r'[{}]', '', text)
            return text.strip()
        except Exception as e:
            return f"[RTF extraction error: {e}]"

    def _analyze_with_llm(self, content: str, file_info: dict[str, Any]) -> str:
        """Analyze file content using OpenAI LLM.

        Sends the file content to OpenAI for intelligent analysis,
        including code review, document summarization, and insight
        extraction.

        Args:
            content: The extracted text content.
            file_info: File metadata dictionary.

        Returns:
            The LLM analysis string.

        Raises:
            ValueError: If OpenAI API key is not configured.
        """
        if not self._openai_api_key:
            raise ValueError("OpenAI API key not configured for LLM analysis")

        try:
            import openai
            client = openai.OpenAI(api_key=self._openai_api_key)

            # Truncate content for API limits
            max_content = 8000
            truncated = content[:max_content]
            if len(content) > max_content:
                truncated += f"\n\n[... content truncated, {len(content)} total characters]"

            language = CODE_LANGUAGES.get(file_info.get("file_type", ""), "Unknown")
            filename = file_info.get("filename", "unknown")

            prompt = (
                f"Analyze the following {language} file '{filename}' and provide:\n"
                f"1. A brief summary of what the file does\n"
                f"2. Key components and structure\n"
                f"3. Any notable patterns, issues, or suggestions\n"
                f"4. Security considerations (if applicable)\n\n"
                f"File content:\n```\n{truncated}\n```"
            )

            response = client.chat.completions.create(
                model=self._openai_model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are JARVIS, an expert code and document analyst. "
                            "Provide concise, insightful analysis of uploaded files. "
                            "Focus on practical insights and actionable suggestions."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=1000,
                temperature=0.3,
            )

            analysis = response.choices[0].message.content or ""
            logger.info("LLM analysis completed for %s", filename)
            return analysis

        except ImportError:
            raise RuntimeError("OpenAI package not installed")
        except Exception as e:
            logger.error("LLM analysis failed: %s", e)
            return f"[LLM analysis error: {e}]"

    def _generate_summary(self, content: str, file_type: str) -> str:
        """Generate a brief summary of file content.

        Args:
            content: The file content string.
            file_type: The file category.

        Returns:
            A summary string.
        """
        lines = content.split("\n")
        non_empty_lines = [l for l in lines if l.strip()]
        total_lines = len(lines)
        total_chars = len(content)

        language = CODE_LANGUAGES.get(file_type, file_type)

        # Count specific patterns for code files
        if file_type in CODE_LANGUAGES:
            functions = len(re.findall(
                r'(?:def |function |func |fn |pub fn |class |interface |type )',
                content,
            ))
            comments = len(re.findall(r'(?:#|//|/\*|--|;)\s', content))
            imports = len(re.findall(
                r'(?:import |from |require\(|use |include |#include)',
                content,
            ))

            return (
                f"{language} file: {total_lines} lines, "
                f"{total_chars} characters, "
                f"{functions} definitions, "
                f"{imports} imports, "
                f"{comments} comment lines"
            )

        elif file_type in ("json", "yaml", "toml", "xml"):
            return f"{language.upper()} data file: {total_lines} lines, {total_chars} characters"

        elif file_type == "csv":
            row_count = len(non_empty_lines) - 1  # Exclude header
            return f"CSV data: ~{row_count} rows, {total_chars} characters"

        elif file_type == "markdown":
            headings = len(re.findall(r'^#+\s', content, re.MULTILINE))
            return f"Markdown document: {total_lines} lines, {headings} headings"

        else:
            return f"{file_type} file: {total_lines} lines, {total_chars} characters"

    def _extract_personalization_data(
        self, content: str, file_type: str
    ) -> dict[str, Any]:
        """Extract personalization-relevant data from file content.

        Analyzes the content to identify user preferences, coding style,
        technology choices, and other personalizable attributes.

        Args:
            content: The file content string.
            file_type: The file category.

        Returns:
            A dictionary of personalization data.
        """
        personalization: dict[str, Any] = {}

        # Code files: extract tech stack and patterns
        if file_type in CODE_LANGUAGES:
            # Frameworks and libraries
            frameworks: list[str] = []
            framework_patterns = {
                "react": r"(?:import.*from\s+['\"]react|from\s+['\"]react)",
                "vue": r"(?:import.*from\s+['\"]vue|createApp|Vue\.)",
                "angular": r"(?:@angular|import.*from\s+['\"]@angular)",
                "django": r"(?:from\s+django|import\s+django)",
                "flask": r"(?:from\s+flask|import\s+flask)",
                "fastapi": r"(?:from\s+fastapi|import\s+fastapi)",
                "express": r"(?:require\(['\"]express|from\s+['\"]express)",
                "nextjs": r"(?:from\s+['\"]next|next/image|next/link)",
                "tailwind": r"(?:tailwind|@apply)",
                "pytest": r"(?:import\s+pytest|from\s+pytest)",
                "jest": r"(?:from\s+['\"]@jest|describe\(|it\()",
                "sqlalchemy": r"(?:from\s+sqlalchemy|import\s+sqlalchemy)",
                "prisma": r"(?:from\s+['\"]@prisma|prisma\.)",
            }
            for fw, pattern in framework_patterns.items():
                if re.search(pattern, content, re.IGNORECASE):
                    frameworks.append(fw)

            if frameworks:
                personalization["frameworks"] = frameworks

            # Coding style indicators
            style: dict[str, Any] = {}

            # Indentation style
            if re.search(r'^\t+', content, re.MULTILINE):
                style["indentation"] = "tabs"
            elif re.search(r'^  +', content, re.MULTILINE):
                style["indentation"] = "spaces"

            # Quote style
            single_quotes = len(re.findall(r"'", content))
            double_quotes = len(re.findall(r'"', content))
            if single_quotes > double_quotes * 2:
                style["quote_style"] = "single"
            elif double_quotes > single_quotes * 2:
                style["quote_style"] = "double"

            # Semicolons (for JS/TS)
            if file_type in ("javascript", "typescript"):
                semicolons = len(re.findall(r';\s*$', content, re.MULTILINE))
                total_lines = len(content.split("\n"))
                if total_lines > 0:
                    semicolon_ratio = semicolons / total_lines
                    style["semicolons"] = semicolon_ratio > 0.3

            if style:
                personalization["coding_style"] = style

        # Config files: extract preferences
        if file_type in ("ini", "yaml", "toml", "json"):
            # Look for common config patterns
            if "editor" in content.lower() or "vscode" in content.lower():
                personalization["editor_config"] = True
            if "theme" in content.lower():
                theme_match = re.search(r'theme["\s:=]+(["\']?)(\w+)', content, re.IGNORECASE)
                if theme_match:
                    personalization["theme_preference"] = theme_match.group(2)

        # Determine expertise level from code complexity
        if file_type in CODE_LANGUAGES:
            complexity_indicators = {
                "advanced": [
                    r"decorator", r"metaclass", r"__init_subclass__",
                    r"async\s+def", r"await", r"yield\s+from",
                    r"generic", r"trait", r"macro",
                    r"concurrent", r"parallel", r"mutex",
                ],
                "intermediate": [
                    r"class\s+\w+", r"def\s+\w+", r"function\s+\w+",
                    r"interface\s+\w+", r"type\s+\w+\s*=",
                    r"try\s*{", r"catch\s*\(",
                    r"Promise", r"Observable",
                ],
            }

            advanced_count = sum(
                1 for p in complexity_indicators["advanced"]
                if re.search(p, content, re.IGNORECASE)
            )
            intermediate_count = sum(
                1 for p in complexity_indicators["intermediate"]
                if re.search(p, content, re.IGNORECASE)
            )

            if advanced_count >= 3:
                personalization["expertise_level"] = "advanced"
            elif intermediate_count >= 2:
                personalization["expertise_level"] = "intermediate"
            else:
                personalization["expertise_level"] = "beginner"

        return personalization

    def _build_personalization_profile(
        self, uploads: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """Build a comprehensive personalization profile from all uploads.

        Aggregates data from all processed uploads to create a unified
        personalization profile for the user.

        Args:
            uploads: List of upload record dictionaries.

        Returns:
            A comprehensive personalization profile dictionary.
        """
        profile: dict[str, Any] = {
            "total_uploads": len(uploads),
            "file_types": defaultdict(int),
            "languages": set(),
            "frameworks": set(),
            "expertise_level": "beginner",
            "coding_style": {},
            "preferences": {},
            "upload_timestamps": [],
        }

        for upload in uploads:
            file_type = upload.get("file_type", "unknown")
            profile["file_types"][file_type] += 1
            profile["upload_timestamps"].append(upload.get("uploaded_at"))

            # Collect languages
            language = CODE_LANGUAGES.get(file_type)
            if language:
                profile["languages"].add(language)

            # Collect personalization data
            pers = upload.get("personalization", {})
            if "frameworks" in pers:
                profile["frameworks"].update(pers["frameworks"])
            if "coding_style" in pers:
                profile["coding_style"].update(pers["coding_style"])
            if "expertise_level" in pers:
                current = profile["expertise_level"]
                new = pers["expertise_level"]
                level_order = {"beginner": 0, "intermediate": 1, "advanced": 2}
                if level_order.get(new, 0) > level_order.get(current, 0):
                    profile["expertise_level"] = new
            if "theme_preference" in pers:
                profile["preferences"]["theme"] = pers["theme_preference"]

        # Convert sets to sorted lists for JSON serialization
        profile["languages"] = sorted(profile["languages"])
        profile["frameworks"] = sorted(profile["frameworks"])
        profile["file_types"] = dict(profile["file_types"])

        return profile

    def get_personalization_profile(self) -> dict[str, Any]:
        """Get the current personalization profile from all uploads.

        Returns:
            The aggregated personalization profile.
        """
        return self._build_personalization_profile(self._uploads)

    def get_upload_history(self) -> list[dict[str, Any]]:
        """Get the history of all processed uploads.

        Returns:
            A list of upload record dictionaries.
        """
        return list(self._uploads)

    def get_upload_summary(self) -> dict[str, Any]:
        """Get a summary of all processed uploads.

        Returns:
            A summary dictionary with counts and statistics.
        """
        total_uploads = len(self._uploads)
        total_size = sum(u.get("file_size", 0) for u in self._uploads)
        type_counts: dict[str, int] = defaultdict(int)
        for u in self._uploads:
            type_counts[u.get("file_type", "unknown")] += 1

        return {
            "total_uploads": total_uploads,
            "total_size_bytes": total_size,
            "total_size_mb": round(total_size / (1024 * 1024), 2),
            "type_counts": dict(type_counts),
            "upload_dir": self._upload_dir,
        }

    def clear_uploads(self) -> None:
        """Clear all upload records and delete stored files."""
        # Remove stored files
        for upload in self._uploads:
            path = upload.get("upload_path")
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass

        self._uploads.clear()
        logger.info("Upload history cleared")

    def get_supported_extensions(self) -> dict[str, list[str]]:
        """Return all supported file extensions grouped by category.

        Returns:
            A dictionary mapping category names to lists of extensions.
        """
        result: dict[str, list[str]] = {}
        for category, extensions in FILE_CATEGORIES.items():
            result[category] = sorted(extensions)
        return result

    def is_supported(self, filename: str) -> bool:
        """Check if a file extension is supported.

        Args:
            filename: The filename to check.

        Returns:
            True if the file extension is supported.
        """
        ext = Path(filename).suffix.lower()
        if ext in ALL_EXTENSIONS:
            return True

        # Check for extensionless files (Dockerfile, Makefile, etc.)
        base = Path(filename).name.lower()
        return base in {k.lower() for k in ALL_EXTENSIONS if not k.startswith(".")}

    def get_status(self) -> dict[str, Any]:
        """Return the handler status.

        Returns:
            A status dictionary.
        """
        return {
            "upload_dir": self._upload_dir,
            "max_file_size": self.max_file_size,
            "max_file_size_mb": self.max_file_size // (1024 * 1024),
            "total_uploads": len(self._uploads),
            "llm_analysis_enabled": self._openai_api_key is not None,
            "supported_extensions": len(ALL_EXTENSIONS),
        }

    def __repr__(self) -> str:
        """Return a string representation of the UploadHandler."""
        return (
            f"UploadHandler(uploads={len(self._uploads)}, "
            f"max_size={self.max_file_size // (1024 * 1024)}MB)"
        )
